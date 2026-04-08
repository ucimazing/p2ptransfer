use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// Number of parallel TCP streams for transfer.
pub const NUM_STREAMS: usize = 8;

/// Chunk size: 1MB for native TCP (much larger than WebRTC's 256KB).
pub const CHUNK_SIZE: usize = 1024 * 1024;

/// Port range for direct TCP listener.
pub const BASE_PORT: u16 = 9900;

/// File metadata sent before transfer begins.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileHeader {
    pub name: String,
    pub size: u64,
    pub total_chunks: u64,
    pub num_streams: usize,
    pub chunk_size: usize,
    pub checksum: String, // SHA-256 of original file
}

/// Signaling message exchanged via WebSocket.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignalMessage {
    #[serde(rename = "type")]
    pub msg_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<serde_json::Value>,
    #[serde(rename = "roomId", skip_serializing_if = "Option::is_none")]
    pub room_id: Option<String>,
}

/// Connection info exchanged between peers via signaling.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectInfo {
    pub addr: String,
    pub port: u16,
    pub file_header: FileHeader,
}

/// Send a length-prefixed message over TCP.
pub async fn send_message(stream: &mut TcpStream, data: &[u8]) -> std::io::Result<()> {
    let len = data.len() as u32;
    stream.write_all(&len.to_be_bytes()).await?;
    stream.write_all(data).await?;
    stream.flush().await?;
    Ok(())
}

/// Receive a length-prefixed message from TCP.
pub async fn recv_message(stream: &mut TcpStream) -> std::io::Result<Vec<u8>> {
    let mut len_buf = [0u8; 4];
    stream.read_exact(&mut len_buf).await?;
    let len = u32::from_be_bytes(len_buf) as usize;

    let mut buf = vec![0u8; len];
    stream.read_exact(&mut buf).await?;
    Ok(buf)
}

/// Send a chunk: 8-byte index + data.
pub async fn send_chunk(
    stream: &mut TcpStream,
    index: u64,
    data: &[u8],
) -> std::io::Result<()> {
    // Total length: 8 (index) + data len
    let total_len = (8 + data.len()) as u32;
    stream.write_all(&total_len.to_be_bytes()).await?;
    stream.write_all(&index.to_be_bytes()).await?;
    stream.write_all(data).await?;
    Ok(())
}

/// Receive a chunk: returns (index, data).
pub async fn recv_chunk(stream: &mut TcpStream) -> std::io::Result<(u64, Vec<u8>)> {
    let mut len_buf = [0u8; 4];
    stream.read_exact(&mut len_buf).await?;
    let total_len = u32::from_be_bytes(len_buf) as usize;

    let mut index_buf = [0u8; 8];
    stream.read_exact(&mut index_buf).await?;
    let index = u64::from_be_bytes(index_buf);

    let data_len = total_len - 8;
    let mut data = vec![0u8; data_len];
    stream.read_exact(&mut data).await?;

    Ok((index, data))
}
