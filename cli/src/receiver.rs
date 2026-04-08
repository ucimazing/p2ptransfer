use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tokio::fs::File;
use tokio::io::{AsyncSeekExt, AsyncWriteExt, SeekFrom};
use tokio::net::TcpStream;

use crate::progress;
use crate::protocol::*;
use crate::signaling::SignalingClient;

/// Receive a file via the FastTransfer network.
pub async fn receive_file(server: &str, room_id: &str, output_dir: &str) -> anyhow::Result<()> {
    println!("  Joining room: {}", room_id);
    println!("  Connecting to signaling server...");

    // Connect to signaling server
    let mut signaling = SignalingClient::connect(server, room_id, "receiver").await?;

    // Wait for sender's connection info
    println!("  Waiting for sender...");
    let connect_info: ConnectInfo;

    loop {
        if let Some(msg) = signaling.recv().await? {
            match msg.msg_type.as_str() {
                "peer-joined" => {
                    println!("  Connected to sender!");
                }
                "connect-info" => {
                    connect_info = serde_json::from_value(msg.payload.unwrap())?;
                    break;
                }
                _ => continue,
            }
        }
    }

    let header = &connect_info.file_header;
    println!();
    println!("  File:     {}", header.name);
    println!("  Size:     {}", progress::format_bytes(header.size));
    println!("  Chunks:   {} x 1MB across {} streams", header.total_chunks, header.num_streams);
    println!("  Checksum: {}...", &header.checksum[..16]);
    println!();

    // Try direct TCP connection to sender
    let sender_addr = format!("{}:{}", connect_info.addr, connect_info.port);
    println!("  Connecting to sender at {}...", sender_addr);

    // Signal ready
    signaling
        .send(SignalMessage {
            msg_type: "ready".to_string(),
            payload: Some(serde_json::Value::String("direct".to_string())),
            room_id: None,
        })
        .await?;

    // Open NUM_STREAMS TCP connections to sender
    let mut streams = Vec::new();
    for _ in 0..NUM_STREAMS {
        let stream = TcpStream::connect(&sender_addr).await?;
        stream.set_nodelay(true)?;
        streams.push(stream);
    }

    println!("  {} TCP streams connected!", NUM_STREAMS);

    // Read file header from first stream
    let header_data = recv_message(&mut streams[0]).await?;
    let file_header: FileHeader = serde_json::from_slice(&header_data)?;

    // Create output file
    let output_path = format!("{}/{}", output_dir, file_header.name);
    let file = File::create(&output_path).await?;
    // Pre-allocate file size
    file.set_len(file_header.size).await?;

    // Progress tracking
    let pb = progress::create_progress_bar(file_header.size);
    let bytes_received = Arc::new(AtomicU64::new(0));
    let start = Instant::now();
    let file = Arc::new(tokio::sync::Mutex::new(file));

    // Receive chunks on all streams in parallel
    let mut handles = Vec::new();
    for mut stream in streams {
        let bytes_received = bytes_received.clone();
        let file = file.clone();
        let chunk_size = file_header.chunk_size;

        let handle = tokio::spawn(async move {
            loop {
                match recv_chunk(&mut stream).await {
                    Ok((index, data)) => {
                        // End-of-stream marker
                        if index == u64::MAX {
                            break;
                        }

                        let offset = index * chunk_size as u64;
                        let data_len = data.len() as u64;

                        // Write chunk to file at correct offset
                        let mut f = file.lock().await;
                        f.seek(SeekFrom::Start(offset)).await.unwrap();
                        f.write_all(&data).await.unwrap();
                        drop(f);

                        bytes_received.fetch_add(data_len, Ordering::Relaxed);
                    }
                    Err(e) => {
                        eprintln!("  Error receiving chunk: {}", e);
                        break;
                    }
                }
            }
        });
        handles.push(handle);
    }

    // Update progress bar
    let pb_clone = pb.clone();
    let bytes_received_clone = bytes_received.clone();
    let total = file_header.size;
    let progress_handle = tokio::spawn(async move {
        loop {
            let received = bytes_received_clone.load(Ordering::Relaxed);
            pb_clone.set_position(received);
            if received >= total {
                break;
            }
            tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
        }
    });

    // Wait for all streams
    for handle in handles {
        handle.await?;
    }
    progress_handle.abort();
    pb.set_position(file_header.size);
    pb.finish();

    // Flush file
    {
        let mut f = file.lock().await;
        f.flush().await?;
    }

    progress::print_summary(&file_header.name, file_header.size, start);

    // Verify checksum
    print!("  Verifying checksum...");
    let checksum = compute_sha256(&output_path).await?;
    if checksum == file_header.checksum {
        println!(" OK");
        println!("  Saved to: {}", output_path);
    } else {
        println!(" MISMATCH!");
        println!("  Expected: {}", file_header.checksum);
        println!("  Got:      {}", checksum);
        anyhow::bail!("Checksum mismatch — file may be corrupted");
    }

    Ok(())
}

/// Compute SHA-256 hash of a file.
async fn compute_sha256(path: &str) -> anyhow::Result<String> {
    let mut file = File::open(path).await?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];

    loop {
        let n = tokio::io::AsyncReadExt::read(&mut file, &mut buf).await?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }

    Ok(hex::encode(hasher.finalize()))
}
