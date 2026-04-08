# Multi-stage build for minimal image size
FROM golang:1.24-alpine AS builder

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download

COPY cmd/ cmd/
COPY internal/ internal/
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /fasttransfer ./cmd/server/main.go

# Runtime image
FROM alpine:3.21

RUN apk add --no-cache ca-certificates
COPY --from=builder /fasttransfer /usr/local/bin/fasttransfer
COPY web/ /app/web/

WORKDIR /app

EXPOSE 8080 9800

ENTRYPOINT ["fasttransfer"]
CMD ["-port", "8080", "-relay-port", "9800"]
