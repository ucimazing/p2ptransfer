package main

import (
	"flag"
	"fmt"
	"html/template"
	"log"
	"net/http"
	"os"
	"path/filepath"

	"github.com/umeshdas/fasttransfer/internal/handlers"
	"github.com/umeshdas/fasttransfer/internal/signaling"
)

func main() {
	port := flag.Int("port", 8080, "Server port")
	relayPort := flag.Int("relay-port", 9800, "TCP relay port for CLI NAT fallback")
	flag.Parse()

	// Find project root (where web/ directory lives)
	root := findProjectRoot()

	hub := signaling.NewHub()
	h := handlers.NewHandler(hub)

	// Parse templates
	tmplDir := filepath.Join(root, "web", "templates")
	templates := template.Must(template.ParseGlob(filepath.Join(tmplDir, "*.html")))

	// API routes
	http.HandleFunc("/api/room", h.HandleCreateRoom)
	http.HandleFunc("/api/turn", handlers.HandleTURNCredentials)
	http.HandleFunc("/ws", h.HandleWebSocket)

	// Static files
	staticDir := filepath.Join(root, "web", "static")
	http.Handle("/static/", http.StripPrefix("/static/", http.FileServer(http.Dir(staticDir))))

	// Page routes
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		templates.ExecuteTemplate(w, "index.html", nil)
	})

	http.HandleFunc("/send", func(w http.ResponseWriter, r *http.Request) {
		templates.ExecuteTemplate(w, "send.html", nil)
	})

	// SEO files
	http.HandleFunc("/robots.txt", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, filepath.Join(staticDir, "robots.txt"))
	})
	http.HandleFunc("/sitemap.xml", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, filepath.Join(staticDir, "sitemap.xml"))
	})

	http.HandleFunc("/receive/", func(w http.ResponseWriter, r *http.Request) {
		roomID := r.URL.Path[len("/receive/"):]
		if roomID == "" {
			http.Error(w, "Room ID required", http.StatusBadRequest)
			return
		}
		templates.ExecuteTemplate(w, "receive.html", map[string]string{"RoomID": roomID})
	})

	// Start TCP relay server for CLI clients behind NAT
	relayHub := handlers.NewRelayHub()
	go func() {
		relayAddr := fmt.Sprintf(":%d", *relayPort)
		if err := relayHub.RunRelayServer(relayAddr); err != nil {
			log.Printf("Relay server error: %v", err)
		}
	}()

	addr := fmt.Sprintf(":%d", *port)
	log.Printf("FastTransfer server running on http://localhost%s", addr)
	log.Printf("TCP relay server running on port %d", *relayPort)
	if err := http.ListenAndServe(addr, nil); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
		os.Exit(1)
	}
}

func findProjectRoot() string {
	// Try working directory first
	wd, _ := os.Getwd()
	if _, err := os.Stat(filepath.Join(wd, "web")); err == nil {
		return wd
	}
	// Try two levels up from binary (cmd/server/)
	exe, _ := os.Executable()
	dir := filepath.Dir(filepath.Dir(filepath.Dir(exe)))
	if _, err := os.Stat(filepath.Join(dir, "web")); err == nil {
		return dir
	}
	log.Fatal("Cannot find web/ directory. Run from project root.")
	return ""
}
