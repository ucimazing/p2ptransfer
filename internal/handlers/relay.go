package handlers

import (
	"io"
	"log"
	"net"
	"sync"
	"time"
)

// RelayHub manages TCP relay sessions for CLI clients behind NAT.
type RelayHub struct {
	pending map[string]net.Conn
	mu      sync.Mutex
}

// NewRelayHub creates a new relay hub.
func NewRelayHub() *RelayHub {
	return &RelayHub{
		pending: make(map[string]net.Conn),
	}
}

// RunRelayServer starts a TCP relay server on the given address.
// Protocol: first 12 bytes = room ID, next 1 byte = role ('S' or 'R').
// When both sender and receiver connect, data is piped between them.
func (rh *RelayHub) RunRelayServer(addr string) error {
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	log.Printf("TCP relay server listening on %s", addr)

	for {
		conn, err := listener.Accept()
		if err != nil {
			log.Printf("Relay accept error: %v", err)
			continue
		}
		go rh.handleRelayConn(conn)
	}
}

func (rh *RelayHub) handleRelayConn(conn net.Conn) {
	// Read room ID (12 bytes) + role (1 byte)
	conn.SetReadDeadline(time.Now().Add(30 * time.Second))
	header := make([]byte, 13)
	if _, err := io.ReadFull(conn, header); err != nil {
		log.Printf("Relay: failed to read header: %v", err)
		conn.Close()
		return
	}
	conn.SetReadDeadline(time.Time{}) // Clear deadline

	roomID := string(header[:12])
	role := header[12]

	log.Printf("Relay: [Room %s] %c connected", roomID, role)

	rh.mu.Lock()
	peer, exists := rh.pending[roomID]
	if exists {
		delete(rh.pending, roomID)
		rh.mu.Unlock()

		// Both peers connected — pipe data bidirectionally
		log.Printf("Relay: [Room %s] Paired! Starting relay", roomID)
		relay(conn, peer)
	} else {
		rh.pending[roomID] = conn
		rh.mu.Unlock()

		// Wait up to 60 seconds for peer
		time.AfterFunc(60*time.Second, func() {
			rh.mu.Lock()
			if c, ok := rh.pending[roomID]; ok && c == conn {
				delete(rh.pending, roomID)
				conn.Close()
				log.Printf("Relay: [Room %s] Timed out waiting for peer", roomID)
			}
			rh.mu.Unlock()
		})
	}
}

// relay pipes data between two connections bidirectionally.
func relay(a, b net.Conn) {
	var wg sync.WaitGroup
	wg.Add(2)

	pipe := func(dst, src net.Conn) {
		defer wg.Done()
		buf := make([]byte, 256*1024) // 256KB buffer for speed
		io.CopyBuffer(dst, src, buf)
		dst.Close()
	}

	go pipe(a, b)
	go pipe(b, a)

	wg.Wait()
	log.Printf("Relay: session ended")
}
