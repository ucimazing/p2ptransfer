package signaling

import (
	"crypto/rand"
	"encoding/hex"
	"sync"
)

// Hub manages all active transfer rooms.
type Hub struct {
	rooms map[string]*Room
	mu    sync.RWMutex
}

// NewHub creates a new Hub.
func NewHub() *Hub {
	return &Hub{
		rooms: make(map[string]*Room),
	}
}

// CreateRoom creates a new room and returns its ID.
func (h *Hub) CreateRoom() (*Room, string) {
	id := generateRoomID()
	room := &Room{
		ID:       id,
		Messages: make(chan Message, 256),
	}
	h.mu.Lock()
	h.rooms[id] = room
	h.mu.Unlock()
	return room, id
}

// GetRoom returns a room by ID, or nil if not found.
func (h *Hub) GetRoom(id string) *Room {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.rooms[id]
}

// CreateRoomWithID creates a room with a specific ID.
func (h *Hub) CreateRoomWithID(id string) *Room {
	room := &Room{
		ID:       id,
		Messages: make(chan Message, 256),
	}
	h.mu.Lock()
	h.rooms[id] = room
	h.mu.Unlock()
	return room
}

// RemoveRoom deletes a room.
func (h *Hub) RemoveRoom(id string) {
	h.mu.Lock()
	delete(h.rooms, id)
	h.mu.Unlock()
}

func generateRoomID() string {
	b := make([]byte, 6)
	rand.Read(b)
	return hex.EncodeToString(b)
}
