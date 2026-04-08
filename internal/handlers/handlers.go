package handlers

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/gorilla/websocket"
	"github.com/umeshdas/fasttransfer/internal/signaling"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024 * 64,
	WriteBufferSize: 1024 * 64,
	CheckOrigin: func(r *http.Request) bool {
		return true // Allow all origins in dev; restrict in production
	},
}

// Handler holds the signaling hub and serves HTTP/WebSocket requests.
type Handler struct {
	Hub *signaling.Hub
}

// NewHandler creates a new Handler.
func NewHandler(hub *signaling.Hub) *Handler {
	return &Handler{Hub: hub}
}

// HandleCreateRoom creates a new room and returns the room ID.
func (h *Handler) HandleCreateRoom(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	_, id := h.Hub.CreateRoom()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"roomId": id})
}

// HandleWebSocket handles WebSocket connections for signaling.
func (h *Handler) HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	roomID := r.URL.Query().Get("room")
	role := r.URL.Query().Get("role")

	if roomID == "" || (role != "sender" && role != "receiver") {
		http.Error(w, "Missing room or invalid role", http.StatusBadRequest)
		return
	}

	room := h.Hub.GetRoom(roomID)
	if room == nil {
		// Auto-create room if sender connects first
		if role == "sender" {
			room = h.Hub.CreateRoomWithID(roomID)
		} else {
			http.Error(w, "Room not found", http.StatusNotFound)
			return
		}
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WebSocket upgrade error: %v", err)
		return
	}

	client := &signaling.Client{
		Conn: conn,
		Role: role,
	}

	if role == "sender" {
		room.SetSender(client)
	} else {
		room.SetReceiver(client)
	}

	log.Printf("[Room %s] %s connected", roomID, role)

	// Notify both peers when room is ready
	if room.IsReady() {
		room.Sender.Send(signaling.Message{Type: "peer-joined", Payload: "receiver"})
		room.Receiver.Send(signaling.Message{Type: "peer-joined", Payload: "sender"})
		log.Printf("[Room %s] Both peers connected, ready for transfer", roomID)
	}

	// Read signaling messages and forward to peer
	defer func() {
		conn.Close()
		// Notify peer about disconnection
		peer := room.GetPeer(role)
		if peer != nil {
			peer.Send(signaling.Message{Type: "peer-disconnected"})
		}
		// Clean up room if sender leaves
		if role == "sender" {
			h.Hub.RemoveRoom(roomID)
			log.Printf("[Room %s] Sender left, room destroyed", roomID)
		}
	}()

	for {
		_, rawMsg, err := conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				log.Printf("[Room %s] %s read error: %v", roomID, role, err)
			}
			break
		}

		var msg signaling.Message
		if err := json.Unmarshal(rawMsg, &msg); err != nil {
			log.Printf("[Room %s] Invalid message from %s: %v", roomID, role, err)
			continue
		}

		// Forward signaling messages to peer
		peer := room.GetPeer(role)
		if peer != nil {
			if err := peer.Send(msg); err != nil {
				log.Printf("[Room %s] Error forwarding from %s to peer: %v", roomID, role, err)
			}
		}
	}
}
