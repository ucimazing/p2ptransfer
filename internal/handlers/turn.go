package handlers

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"time"
)

// TURNCredentials represents time-limited TURN credentials.
type TURNCredentials struct {
	Username string   `json:"username"`
	Password string   `json:"password"`
	TTL      int      `json:"ttl"`
	URIs     []string `json:"uris"`
}

// HandleTURNCredentials generates time-limited TURN credentials.
// Uses the shared secret with Coturn's use-auth-secret mechanism.
func HandleTURNCredentials(w http.ResponseWriter, r *http.Request) {
	secret := os.Getenv("TURN_SECRET")
	turnHost := os.Getenv("TURN_HOST")

	// If TURN is not configured, return empty ICE servers
	if secret == "" || turnHost == "" {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"iceServers": []interface{}{},
		})
		return
	}

	// Generate time-limited credentials (valid for 24 hours)
	ttl := 86400
	timestamp := time.Now().Unix() + int64(ttl)
	username := fmt.Sprintf("%d:fasttransfer", timestamp)

	// HMAC-SHA1 of username with shared secret
	mac := hmac.New(sha1.New, []byte(secret))
	mac.Write([]byte(username))
	password := base64.StdEncoding.EncodeToString(mac.Sum(nil))

	creds := TURNCredentials{
		Username: username,
		Password: password,
		TTL:      ttl,
		URIs: []string{
			fmt.Sprintf("turn:%s:3478", turnHost),
			fmt.Sprintf("turn:%s:3478?transport=tcp", turnHost),
		},
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(creds)
}
