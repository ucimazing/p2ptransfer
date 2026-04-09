package handlers

import (
	"io"
	"log"
	"net/http"
	"sync"

	"github.com/gorilla/websocket"
)

// High-throughput WebSocket relay for file transfer.
// Uses NextReader/NextWriter + io.Copy for zero-intermediate-buffer relay.
// Each direction: network → gorilla read buf → io.Copy 32KB → gorilla write buf → network.

var relayUpgrader = websocket.Upgrader{
	ReadBufferSize:  256 * 1024, // 256KB — large buffers for throughput
	WriteBufferSize: 256 * 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
	EnableCompression: false, // Compression kills throughput and spikes CPU
}

// relayRoom holds a sender and receiver WebSocket connection for binary relay.
type relayRoom struct {
	mu       sync.Mutex
	sender   *websocket.Conn
	receiver *websocket.Conn
	ready    chan struct{}
}

// RelayWSHub manages WebSocket relay rooms.
type RelayWSHub struct {
	mu    sync.Mutex
	rooms map[string]*relayRoom
}

// NewRelayWSHub creates a new relay hub.
func NewRelayWSHub() *RelayWSHub {
	return &RelayWSHub{
		rooms: make(map[string]*relayRoom),
	}
}

func (h *RelayWSHub) getOrCreateRoom(roomID string) *relayRoom {
	h.mu.Lock()
	defer h.mu.Unlock()
	room, ok := h.rooms[roomID]
	if !ok {
		room = &relayRoom{ready: make(chan struct{})}
		h.rooms[roomID] = room
	}
	return room
}

func (h *RelayWSHub) removeRoom(roomID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.rooms, roomID)
}

// HandleRelayWS upgrades to WebSocket and relays binary data between sender and receiver.
func (h *RelayWSHub) HandleRelayWS(w http.ResponseWriter, r *http.Request) {
	roomID := r.URL.Query().Get("room")
	role := r.URL.Query().Get("role")

	if roomID == "" || (role != "sender" && role != "receiver") {
		http.Error(w, "Missing room or invalid role", http.StatusBadRequest)
		return
	}

	conn, err := relayUpgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[Relay] Upgrade error: %v", err)
		return
	}

	// Allow large messages (256KB chunks + 4 byte header)
	conn.SetReadLimit(512 * 1024)

	room := h.getOrCreateRoom(roomID)

	room.mu.Lock()
	if role == "sender" {
		room.sender = conn
	} else {
		room.receiver = conn
	}
	bothReady := room.sender != nil && room.receiver != nil
	room.mu.Unlock()

	log.Printf("[Relay %s] %s connected", roomID, role)

	if bothReady {
		close(room.ready) // Signal both goroutines to start relaying
	} else {
		// Wait for the other peer
		<-room.ready
	}

	room.mu.Lock()
	sender := room.sender
	receiver := room.receiver
	room.mu.Unlock()

	// Determine direction based on role
	var src, dst *websocket.Conn
	if role == "sender" {
		src = sender
		dst = receiver
	} else {
		src = receiver
		dst = sender
	}

	// Relay: read from src, write to dst using zero-copy NextReader/NextWriter
	wsRelay(src, dst)

	// Cleanup
	conn.Close()
	h.removeRoom(roomID)
	log.Printf("[Relay %s] %s disconnected, relay ended", roomID, role)
}

// relay pipes binary messages from src to dst using NextReader/NextWriter.
// This is the highest-throughput approach: no intermediate buffer allocation.
func wsRelay(src, dst *websocket.Conn) {
	for {
		msgType, reader, err := src.NextReader()
		if err != nil {
			return
		}

		writer, err := dst.NextWriter(msgType)
		if err != nil {
			return
		}

		if _, err := io.Copy(writer, reader); err != nil {
			writer.Close()
			return
		}

		if err := writer.Close(); err != nil {
			return
		}
	}
}
