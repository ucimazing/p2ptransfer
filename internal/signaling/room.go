package signaling

import (
	"sync"

	"github.com/gorilla/websocket"
)

// Message is a signaling message exchanged between peers.
type Message struct {
	Type    string      `json:"type"`
	Payload interface{} `json:"payload,omitempty"`
	RoomID  string      `json:"roomId,omitempty"`
}

// Client represents a connected WebSocket peer.
type Client struct {
	Conn *websocket.Conn
	Role string // "sender" or "receiver"
	mu   sync.Mutex
}

// Send sends a JSON message to the client.
func (c *Client) Send(msg Message) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.Conn.WriteJSON(msg)
}

// Room represents a transfer session between two peers.
type Room struct {
	ID       string
	Sender   *Client
	Receiver *Client
	Messages chan Message
	mu       sync.Mutex
}

// SetSender assigns the sender to the room.
func (r *Room) SetSender(c *Client) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.Sender = c
}

// SetReceiver assigns the receiver to the room.
func (r *Room) SetReceiver(c *Client) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.Receiver = c
}

// GetPeer returns the other peer in the room.
func (r *Room) GetPeer(role string) *Client {
	r.mu.Lock()
	defer r.mu.Unlock()
	if role == "sender" {
		return r.Receiver
	}
	return r.Sender
}

// IsReady returns true if both sender and receiver are connected.
func (r *Room) IsReady() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.Sender != nil && r.Receiver != nil
}
