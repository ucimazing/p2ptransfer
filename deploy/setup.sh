#!/bin/bash
set -e

# ============================================================
# FastTransfer — One-command deployment script
# Run this on your VPS (Ubuntu 22.04+ / Oracle Cloud / AWS)
# Usage: ./setup.sh <duckdns-subdomain> <duckdns-token> [email]
# Example: ./setup.sh fasttransfer abc123-your-token you@email.com
# ============================================================

DUCKDNS_SUBDOMAIN="${1:-}"
DUCKDNS_TOKEN="${2:-}"
EMAIL="${3:-admin@example.com}"
TURN_SECRET="2e2ef44f4d93a7e55afd585f06695060eaeeafa7044932d1"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

print_step() { echo -e "\n${GREEN}[STEP]${NC} $1"; }
print_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
print_err()  { echo -e "${RED}[ERROR]${NC} $1"; }

# ──── Validate args ────
if [ -z "$DUCKDNS_SUBDOMAIN" ] || [ -z "$DUCKDNS_TOKEN" ]; then
    echo "FastTransfer Deployment Script"
    echo ""
    echo "Usage: ./setup.sh <duckdns-subdomain> <duckdns-token> [email-for-ssl]"
    echo ""
    echo "Steps before running this script:"
    echo "  1. Go to https://www.duckdns.org and sign in with Google/GitHub"
    echo "  2. Create a subdomain (e.g., 'fasttransfer' → fasttransfer.duckdns.org)"
    echo "  3. Copy your token from the DuckDNS dashboard"
    echo "  4. Run: ./setup.sh fasttransfer YOUR_TOKEN your@email.com"
    echo ""
    exit 1
fi

DOMAIN="${DUCKDNS_SUBDOMAIN}.duckdns.org"
PUBLIC_IP=$(curl -s ifconfig.me || curl -s icanhazip.com)

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║     FastTransfer Deployment Setup     ║"
echo "  ╠══════════════════════════════════════╣"
echo "  ║  Domain:  ${DOMAIN}"
echo "  ║  IP:      ${PUBLIC_IP}"
echo "  ║  Email:   ${EMAIL}"
echo "  ╚══════════════════════════════════════╝"
echo ""

# ──── Step 1: Update DuckDNS ────
print_step "Updating DuckDNS record..."
DUCKDNS_RESULT=$(curl -s "https://www.duckdns.org/update?domains=${DUCKDNS_SUBDOMAIN}&token=${DUCKDNS_TOKEN}&ip=")
if [ "$DUCKDNS_RESULT" = "OK" ]; then
    echo "  DuckDNS updated: ${DOMAIN} → ${PUBLIC_IP}"
else
    print_err "DuckDNS update failed. Check your subdomain and token."
    exit 1
fi

# Set up cron job to keep DuckDNS updated every 5 minutes
(crontab -l 2>/dev/null | grep -v duckdns; echo "*/5 * * * * curl -s 'https://www.duckdns.org/update?domains=${DUCKDNS_SUBDOMAIN}&token=${DUCKDNS_TOKEN}&ip=' > /dev/null 2>&1") | crontab -
echo "  DuckDNS auto-update cron job installed"

# ──── Step 2: Install Docker ────
print_step "Installing Docker..."
if command -v docker &> /dev/null; then
    echo "  Docker already installed: $(docker --version)"
else
    curl -fsSL https://get.docker.com | sh
    sudo usermod -aG docker $USER
    echo "  Docker installed"
fi

if ! command -v docker compose &> /dev/null && ! docker compose version &> /dev/null; then
    sudo apt-get install -y docker-compose-plugin 2>/dev/null || true
fi

# ──── Step 3: Open firewall ports ────
print_step "Configuring firewall..."

# For Ubuntu/Debian with iptables
if command -v iptables &> /dev/null; then
    # HTTP/HTTPS
    sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT 2>/dev/null || true
    sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT 2>/dev/null || true
    # WebSocket / Go server
    sudo iptables -I INPUT -p tcp --dport 8080 -j ACCEPT 2>/dev/null || true
    # TCP relay for CLI
    sudo iptables -I INPUT -p tcp --dport 9800 -j ACCEPT 2>/dev/null || true
    # TURN server
    sudo iptables -I INPUT -p tcp --dport 3478 -j ACCEPT 2>/dev/null || true
    sudo iptables -I INPUT -p udp --dport 3478 -j ACCEPT 2>/dev/null || true
    sudo iptables -I INPUT -p tcp --dport 5349 -j ACCEPT 2>/dev/null || true
    sudo iptables -I INPUT -p udp --dport 5349 -j ACCEPT 2>/dev/null || true
    # TURN relay ports
    sudo iptables -I INPUT -p udp --dport 49152:49252 -j ACCEPT 2>/dev/null || true
    echo "  iptables rules added"
fi

# For systems with ufw
if command -v ufw &> /dev/null; then
    sudo ufw allow 80/tcp 2>/dev/null || true
    sudo ufw allow 443/tcp 2>/dev/null || true
    sudo ufw allow 8080/tcp 2>/dev/null || true
    sudo ufw allow 9800/tcp 2>/dev/null || true
    sudo ufw allow 3478 2>/dev/null || true
    sudo ufw allow 5349 2>/dev/null || true
    sudo ufw allow 49152:49252/udp 2>/dev/null || true
    echo "  ufw rules added"
fi

echo ""
print_warn "IMPORTANT: If you're on Oracle Cloud / AWS / Azure:"
print_warn "You MUST also open these ports in the cloud console security rules:"
echo "  - TCP: 80, 443, 8080, 9800, 3478, 5349"
echo "  - UDP: 3478, 5349, 49152-49252"
echo ""

# ──── Step 4: Configure Coturn ────
print_step "Configuring TURN server..."
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
sed -i "s|EXTERNAL_IP_PLACEHOLDER|${PUBLIC_IP}|g" "${SCRIPT_DIR}/coturn/turnserver.conf"
echo "  Coturn configured with external IP: ${PUBLIC_IP}"

# ──── Step 5: Configure Nginx ────
print_step "Configuring Nginx..."
sed -i "s|DOMAIN_PLACEHOLDER|${DOMAIN}|g" "${SCRIPT_DIR}/nginx/conf.d/fasttransfer.conf"
echo "  Nginx configured for ${DOMAIN}"

# ──── Step 6: Create .env file ────
print_step "Creating environment config..."
cat > "${SCRIPT_DIR}/.env" <<EOF
DOMAIN=${DOMAIN}
PUBLIC_IP=${PUBLIC_IP}
TURN_HOST=${PUBLIC_IP}
TURN_SECRET=${TURN_SECRET}
DUCKDNS_SUBDOMAIN=${DUCKDNS_SUBDOMAIN}
DUCKDNS_TOKEN=${DUCKDNS_TOKEN}
EMAIL=${EMAIL}
EOF
echo "  .env file created"

# ──── Step 7: Start services (without SSL first) ────
print_step "Building and starting services..."
cd "${SCRIPT_DIR}"
docker compose up --build -d fasttransfer nginx
echo "  Server running on http://${DOMAIN}"

# Wait for nginx to be ready
sleep 5

# ──── Step 8: Get SSL certificate ────
print_step "Obtaining SSL certificate from Let's Encrypt..."
# Create certbot webroot directory
docker compose run --rm certbot certonly \
    --webroot \
    --webroot-path=/var/www/certbot \
    --email "${EMAIL}" \
    --agree-tos \
    --no-eff-email \
    -d "${DOMAIN}" \
    2>&1 || {
    print_warn "SSL certificate failed. The site will work on HTTP only."
    print_warn "You can retry later with: docker compose run --rm certbot certonly --webroot --webroot-path=/var/www/certbot -d ${DOMAIN}"
}

# Enable SSL in nginx if cert was obtained
if docker compose run --rm certbot certificates 2>/dev/null | grep -q "${DOMAIN}"; then
    print_step "Enabling HTTPS in Nginx..."
    # Uncomment the SSL server block
    sed -i '/^# SSL_START/,/^# SSL_END/{s/^# //}' "${SCRIPT_DIR}/nginx/conf.d/fasttransfer.conf"
    # Also enable TURN TLS
    sed -i "s|# cert=/etc/letsencrypt|cert=/etc/letsencrypt|" "${SCRIPT_DIR}/coturn/turnserver.conf"
    sed -i "s|# pkey=/etc/letsencrypt|pkey=/etc/letsencrypt|" "${SCRIPT_DIR}/coturn/turnserver.conf"
    sed -i "s|DOMAIN|${DOMAIN}|g" "${SCRIPT_DIR}/coturn/turnserver.conf"
    echo "  SSL enabled"
fi

# ──── Step 9: Start all services ────
print_step "Starting all services (including TURN)..."
cd "${SCRIPT_DIR}"
docker compose up --build -d
sleep 3

# ──── Step 10: Verify ────
print_step "Verifying deployment..."
echo ""

HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://${DOMAIN}" 2>/dev/null || echo "failed")
if [ "$HTTP_STATUS" = "200" ]; then
    echo -e "  ${GREEN}HTTP:${NC}  http://${DOMAIN} — OK (${HTTP_STATUS})"
else
    echo -e "  ${RED}HTTP:${NC}  http://${DOMAIN} — ${HTTP_STATUS}"
fi

HTTPS_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "https://${DOMAIN}" 2>/dev/null || echo "no-ssl")
if [ "$HTTPS_STATUS" = "200" ] || [ "$HTTPS_STATUS" = "301" ]; then
    echo -e "  ${GREEN}HTTPS:${NC} https://${DOMAIN} — OK (${HTTPS_STATUS})"
else
    echo -e "  ${YELLOW}HTTPS:${NC} https://${DOMAIN} — ${HTTPS_STATUS} (may take a few minutes)"
fi

echo ""
echo "  ╔══════════════════════════════════════════════════╗"
echo "  ║           Deployment Complete!                    ║"
echo "  ╠══════════════════════════════════════════════════╣"
echo "  ║                                                   ║"
echo "  ║  Web App:   http://${DOMAIN}"
echo "  ║  TURN:      ${PUBLIC_IP}:3478"
echo "  ║  TCP Relay: ${PUBLIC_IP}:9800"
echo "  ║                                                   ║"
echo "  ║  CLI Usage:                                       ║"
echo "  ║  fasttransfer -s http://${DOMAIN} send file.zip"
echo "  ║  fasttransfer -s http://${DOMAIN} receive CODE"
echo "  ║                                                   ║"
echo "  ║  Manage:                                          ║"
echo "  ║  docker compose logs -f    (view logs)            ║"
echo "  ║  docker compose restart    (restart all)          ║"
echo "  ║  docker compose down       (stop all)             ║"
echo "  ║                                                   ║"
echo "  ╚══════════════════════════════════════════════════╝"
echo ""
