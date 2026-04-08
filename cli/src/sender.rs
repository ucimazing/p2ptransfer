use sha2::{Digest, Sha256};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tokio::fs::File;
use tokio::io::{AsyncReadExt, AsyncSeekExt, SeekFrom};
use tokio::net::TcpListener;
use tokio::sync::Notify;

use crate::progress;
use crate::protocol::*;
use crate::signaling::SignalingClient;

/// Send a file via the FastTransfer network.
pub async fn send_file(server: &str, file_path: &str) -> anyhow::Result<()> {
    let path = Path::new(file_path);
    if !path.exists() {
        anyhow::bail!("File not found: {}", file_path);
    }

    let metadata = tokio::fs::metadata(path).await?;
    let file_size = metadata.len();
    let file_name = path.file_name().unwrap().to_string_lossy().to_string();
    let total_chunks = (file_size + CHUNK_SIZE as u64 - 1) / CHUNK_SIZE as u64;

    println!("  File:     {}", file_name);
    println!("  Size:     {}", progress::format_bytes(file_size));
    println!("  Chunks:   {} x 1MB across {} streams", total_chunks, NUM_STREAMS);
    println!();

    // Compute SHA-256 checksum
    print!("  Computing checksum...");
    let checksum = compute_sha256(file_path).await?;
    println!(" {}", &checksum[..16]);

    // Create room via HTTP API
    let client = reqwest::Client::new();
    let resp: serde_json::Value = client
        .post(&format!("{}/api/room", server))
        .send()
        .await?
        .json()
        .await?;
    let room_id = resp["roomId"].as_str().unwrap().to_string();

    println!();
    println!("  Share this code with the receiver:");
    println!("  ┌─────────────────────────┐");
    println!("  │  {}  │", room_id);
    println!("  └─────────────────────────┘");
    println!();
    println!("  Or share this link:");
    println!("  {}/receive/{}", server, room_id);
    println!();
    println!("  Waiting for receiver to connect...");

    // Bind TCP listener for direct transfer
    let listener = TcpListener::bind(format!("0.0.0.0:{}", BASE_PORT)).await?;
    let local_addr = listener.local_addr()?;

    // Connect to signaling server
    let mut signaling = SignalingClient::connect(server, &room_id, "sender").await?;

    // Wait for receiver to join
    loop {
        if let Some(msg) = signaling.recv().await? {
            if msg.msg_type == "peer-joined" {
                println!("  Receiver connected!");
                break;
            }
        }
    }

    // Send connection info via signaling
    let file_header = FileHeader {
        name: file_name.clone(),
        size: file_size,
        total_chunks,
        num_streams: NUM_STREAMS,
        chunk_size: CHUNK_SIZE,
        checksum: checksum.clone(),
    };

    let connect_info = ConnectInfo {
        addr: local_addr.ip().to_string(),
        port: local_addr.port(),
        file_header,
    };

    signaling
        .send(SignalMessage {
            msg_type: "connect-info".to_string(),
            payload: Some(serde_json::to_value(&connect_info)?),
            room_id: None,
        })
        .await?;

    // Wait for receiver to signal ready (they'll try direct TCP first, then relay)
    let mut receiver_addr = None;
    loop {
        if let Some(msg) = signaling.recv().await? {
            if msg.msg_type == "ready" {
                if let Some(payload) = msg.payload {
                    receiver_addr = payload.as_str().map(|s| s.to_string());
                }
                break;
            }
        }
    }

    println!(
        "  Transfer mode: {}",
        if receiver_addr.is_some() {
            "direct TCP"
        } else {
            "relay"
        }
    );
    println!();

    // Accept NUM_STREAMS TCP connections
    let mut streams = Vec::new();
    for _ in 0..NUM_STREAMS {
        let (stream, _) = listener.accept().await?;
        // Set TCP_NODELAY and large buffer for speed
        stream.set_nodelay(true)?;
        streams.push(stream);
    }

    // Send file header on first stream
    let header_json = serde_json::to_vec(&connect_info.file_header)?;
    send_message(&mut streams[0], &header_json).await?;

    // Progress tracking
    let pb = progress::create_progress_bar(file_size);
    let bytes_sent = Arc::new(AtomicU64::new(0));
    let start = Instant::now();
    let done = Arc::new(Notify::new());

    // Distribute chunks across streams
    let mut handles = Vec::new();
    for (stream_idx, mut stream) in streams.into_iter().enumerate() {
        let bytes_sent = bytes_sent.clone();
        let file_path = file_path.to_string();
        let done = done.clone();

        let handle = tokio::spawn(async move {
            let mut file = File::open(&file_path).await.unwrap();
            let mut chunk_idx = stream_idx as u64;

            while chunk_idx < total_chunks {
                let offset = chunk_idx * CHUNK_SIZE as u64;
                let remaining = file_size - offset;
                let read_size = (CHUNK_SIZE as u64).min(remaining) as usize;

                file.seek(SeekFrom::Start(offset)).await.unwrap();
                let mut buf = vec![0u8; read_size];
                file.read_exact(&mut buf).await.unwrap();

                send_chunk(&mut stream, chunk_idx, &buf).await.unwrap();
                bytes_sent.fetch_add(read_size as u64, Ordering::Relaxed);

                chunk_idx += NUM_STREAMS as u64;
            }

            // Send end-of-stream marker
            send_chunk(&mut stream, u64::MAX, &[]).await.unwrap();
            done.notify_one();
        });
        handles.push(handle);
    }

    // Update progress bar
    let pb_clone = pb.clone();
    let bytes_sent_clone = bytes_sent.clone();
    let progress_handle = tokio::spawn(async move {
        loop {
            let sent = bytes_sent_clone.load(Ordering::Relaxed);
            pb_clone.set_position(sent);
            if sent >= file_size {
                break;
            }
            tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
        }
    });

    // Wait for all streams to finish
    for handle in handles {
        handle.await?;
    }
    progress_handle.abort();
    pb.set_position(file_size);
    pb.finish();

    progress::print_summary(&file_name, file_size, start);

    Ok(())
}

/// Compute SHA-256 hash of a file.
async fn compute_sha256(path: &str) -> anyhow::Result<String> {
    let mut file = File::open(path).await?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024]; // 1MB read buffer

    loop {
        let n = file.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }

    Ok(hex::encode(hasher.finalize()))
}
