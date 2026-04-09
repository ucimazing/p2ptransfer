package handlers

import (
	"fmt"
	"io"
	"log"
	"net/http"
	"sync"

	"github.com/gorilla/websocket"
)

// High-throughput WebSocket relay for file transfer.
//
// Supports MULTIPLE parallel relay connections per room (indexed 0-3).
// Each connection pair gets its own TCP stream → its own congestion window.
// With 4 parallel TCP streams using OS-level CUBIC/BBR: ~40-50 MB/s.
//
// Relay uses NextReader/NextWriter + io.Copy for zero-copy throughput.

var relayUpgrader = websocket.Upgrader{
	ReadBufferSize:  256 * 1024,
	WriteBufferSize: 256 * 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
	EnableCompression: false,
}

type relayPair struct {
	mu       sync.Mutex
	sender   *websocket.Conn
	receiver *websocket.Conn
	ready    chan struct{}
	done     bool
}

// RelayWSHub manages WebSocket relay pairs keyed by room+index.
type RelayWSHub struct {
	mu    sync.Mutex
	pairs map[string]*relayPair
}

func NewRelayWSHub() *RelayWSHub {
	return &RelayWSHub{
		pairs: make(map[string]*relayPair),
	}
}

func (h *RelayWSHub) getOrCreatePair(key string) *relayPair {
	h.mu.Lock()
	defer h.mu.Unlock()
	p, ok := h.pairs[key]
	if !ok {
		p = &relayPair{ready: make(chan struct{})}
		h.pairs[key] = p
	}
	return p
}

func (h *RelayWSHub) removePair(key string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.pairs, key)
}

// HandleRelayWS handles /ws-relay?room=X&role=sender|receiver&idx=0-3
func (h *RelayWSHub) HandleRelayWS(w http.ResponseWriter, r *http.Request) {
	roomID := r.URL.Query().Get("room")
	role := r.URL.Query().Get("role")
	idx := r.URL.Query().Get("idx")

	if roomID == "" || (role != "sender" && role != "receiver") {
		http.Error(w, "Missing room or invalid role", http.StatusBadRequest)
		return
	}
	if idx == "" {
		idx = "0"
	}

	conn, err := relayUpgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[Relay] Upgrade error: %v", err)
		return
	}
	conn.SetReadLimit(512 * 1024)

	// Key = room + index → each index pair gets its own TCP relay
	key := fmt.Sprintf("%s:%s", roomID, idx)
	pair := h.getOrCreatePair(key)

	pair.mu.Lock()
	if role == "sender" {
		pair.sender = conn
	} else {
		pair.receiver = conn
	}
	bothReady := pair.sender != nil && pair.receiver != nil
	pair.mu.Unlock()

	log.Printf("[Relay %s] %s connected (idx=%s)", roomID, role, idx)

	if bothReady {
		close(pair.ready)
	} else {
		<-pair.ready
	}

	pair.mu.Lock()
	sender := pair.sender
	receiver := pair.receiver
	pair.mu.Unlock()

	// Only sender goroutine relays sender→receiver.
	// Only receiver goroutine relays receiver→sender (for acks, not used but keeps conn alive).
	if role == "sender" {
		wsRelay(sender, receiver)
	} else {
		wsRelay(receiver, sender)
	}

	conn.Close()
	h.removePair(key)
	log.Printf("[Relay %s] %s disconnected (idx=%s)", roomID, role, idx)
}

// wsRelay pipes messages from src to dst using zero-copy NextReader/NextWriter.
// Uses a 256KB copy buffer (vs default 32KB) to reduce syscall overhead.
func wsRelay(src, dst *websocket.Conn) {
	buf := make([]byte, 256*1024) // 256KB copy buffer
	for {
		msgType, reader, err := src.NextReader()
		if err != nil {
			return
		}
		writer, err := dst.NextWriter(msgType)
		if err != nil {
			return
		}
		if _, err := io.CopyBuffer(writer, reader, buf); err != nil {
			writer.Close()
			return
		}
		if err := writer.Close(); err != nil {
			return
		}
	}
}
