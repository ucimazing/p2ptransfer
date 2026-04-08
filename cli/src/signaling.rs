use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::protocol::SignalMessage;

/// WebSocket signaling client that talks to the Go server.
pub struct SignalingClient {
    write: futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        Message,
    >,
    read: futures_util::stream::SplitStream<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
    >,
}

impl SignalingClient {
    /// Connect to the signaling server.
    pub async fn connect(server_url: &str, room_id: &str, role: &str) -> anyhow::Result<Self> {
        let url = format!("{}/ws?room={}&role={}", server_url, room_id, role);
        let ws_url = url.replace("http://", "ws://").replace("https://", "wss://");

        let (ws_stream, _) = connect_async(&ws_url).await.map_err(|e| {
            anyhow::anyhow!("Failed to connect to signaling server at {}: {}", ws_url, e)
        })?;

        let (write, read) = ws_stream.split();
        Ok(Self { write, read })
    }

    /// Send a signaling message.
    pub async fn send(&mut self, msg: SignalMessage) -> anyhow::Result<()> {
        let json = serde_json::to_string(&msg)?;
        self.write.send(Message::Text(json)).await?;
        Ok(())
    }

    /// Wait for the next signaling message.
    pub async fn recv(&mut self) -> anyhow::Result<Option<SignalMessage>> {
        while let Some(msg) = self.read.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    let signal: SignalMessage = serde_json::from_str(&text)?;
                    return Ok(Some(signal));
                }
                Ok(Message::Close(_)) => return Ok(None),
                Err(e) => return Err(anyhow::anyhow!("WebSocket error: {}", e)),
                _ => continue,
            }
        }
        Ok(None)
    }
}
