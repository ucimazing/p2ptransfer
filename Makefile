.PHONY: run build clean dev cli cli-release deploy

# ──── Go Server ────

# Run the server in development mode
run:
	go run ./cmd/server/main.go

# Run on a specific port
run-port:
	go run ./cmd/server/main.go -port=$(PORT)

# Build the Go server binary
build:
	go build -o bin/fasttransfer-server ./cmd/server/main.go

# Build optimized production binary
build-prod:
	CGO_ENABLED=0 go build -ldflags="-s -w" -o bin/fasttransfer-server ./cmd/server/main.go

# Run with auto-reload (requires: go install github.com/air-verse/air@latest)
dev:
	air -c .air.toml 2>/dev/null || go run ./cmd/server/main.go

# ──── Rust CLI ────

# Build Rust CLI (debug)
cli:
	cd cli && cargo build

# Build Rust CLI (optimized release)
cli-release:
	cd cli && cargo build --release
	@echo "Binary at: cli/target/release/fasttransfer"

# ──── Build All ────

# Build both server and CLI for production
all: build-prod cli-release
	@echo "Server:  bin/fasttransfer-server"
	@echo "CLI:     cli/target/release/fasttransfer"

# ──── Docker / Deploy ────

# Build and start all services (server + coturn + nginx)
deploy:
	cd deploy && docker compose up --build -d

# Stop all services
deploy-stop:
	cd deploy && docker compose down

# View logs
deploy-logs:
	cd deploy && docker compose logs -f

# Build Docker image only
docker-build:
	docker build -f deploy/Dockerfile -t fasttransfer:latest .

# ──── Clean ────

clean:
	rm -rf bin/
	cd cli && cargo clean 2>/dev/null || true
