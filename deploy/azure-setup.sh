#!/bin/bash
set -e

# ============================================================
# FastTransfer — Azure Deployment Script
#
# Prerequisites:
#   1. Azure VM running Ubuntu 22.04 (Standard_B2ms or D2s_v5)
#   2. DuckDNS subdomain + token (https://www.duckdns.org)
#   3. NSG ports opened (run azure-nsg.sh from your local machine first)
#
# Usage: sudo ./azure-setup.sh <duckdns-subdomain> <duckdns-token> [email]
# Example: sudo ./azure-setup.sh fasttransfer abc123-your-token you@email.com
# ============================================================

DUCKDNS_SUBDOMAIN="${1:-}"
DUCKDNS_TOKEN="${2:-}"
EMAIL="${3:-admin@example.com}"
TURN_SECRET="2e2ef44f4d93a7e55afd585f06695060eaeeafa7044932d1"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

print_step() { echo -e "\n${GREEN}[STEP]${NC} $1"; }
print_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }

if [ -z "$DUCKDNS_SUBDOMAIN" ] || [ -z "$DUCKDNS_TOKEN" ]; then
    echo "FastTransfer — Azure Deployment"
    echo ""
    echo "Usage: sudo ./azure-setup.sh <duckdns-subdomain> <duckdns-token> [email]"
    echo ""
    echo "Before running this:"
    echo "  1. Create a DuckDNS subdomain at https://www.duckdns.org"
    echo "  2. Open NSG ports (run azure-nsg.sh from your local machine)"
    echo "  3. SSH into your Azure VM"
    echo ""
    exit 1
fi

DOMAIN="${DUCKDNS_SUBDOMAIN}.duckdns.org"
PUBLIC_IP=$(curl -s -4 ifconfig.me || curl -s -4 icanhazip.com)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo ""
echo "  ╔═══════════════════════════════════════════╗"
echo "  ║     FastTransfer — Azure Deployment        ║"
echo "  ╠═══════════════════════════════════════════╣"
echo "  ║  Domain:    ${DOMAIN}"
echo "  ║  Public IP: ${PUBLIC_IP}"
echo "  ║  Email:     ${EMAIL}"
echo "  ╚═══════════════════════════════════════════╝"
echo ""

# ──── Step 1: System update + Docker ────
print_step "Updating system and installing Docker..."
apt-get update -y
apt-get install -y ca-certificates curl gnupg lsb-release

if ! command -v docker &> /dev/null; then
    curl -fsSL https://get.docker.com | sh
    systemctl enable docker
    systemctl start docker
    echo "  Docker installed"
else
    echo "  Docker already installed: $(docker --version)"
fi

# Ensure docker compose plugin
if ! docker compose version &> /dev/null; then
    apt-get install -y docker-compose-plugin
fi

# ──── Step 2: Update DuckDNS ────
print_step "Updating DuckDNS → ${DOMAIN} → ${PUBLIC_IP}..."
RESULT=$(curl -s "https://www.duckdns.org/update?domains=${DUCKDNS_SUBDOMAIN}&token=${DUCKDNS_TOKEN}&ip=${PUBLIC_IP}")
if [ "$RESULT" = "OK" ]; then
    echo "  DuckDNS updated successfully"
else
    echo -e "  ${RED}DuckDNS update failed!${NC} Check your subdomain and token."
    exit 1
fi

# DuckDNS auto-update cron (every 5 min)
(crontab -l 2>/dev/null | grep -v duckdns; echo "*/5 * * * * curl -s 'https://www.duckdns.org/update?domains=${DUCKDNS_SUBDOMAIN}&token=${DUCKDNS_TOKEN}&ip=' > /dev/null 2>&1") | crontab -
echo "  Auto-update cron installed"

# ──── Step 3: Configure firewall (Azure uses NSG, but also open locally) ────
print_step "Configuring local firewall..."
if command -v ufw &> /dev/null; then
    ufw allow 80/tcp
    ufw allow 443/tcp
    ufw allow 8080/tcp
    ufw allow 9800/tcp
    ufw allow 3478
    ufw allow 5349
    ufw allow 49152:49252/udp
    ufw --force enable
    echo "  UFW rules applied"
else
    # iptables fallback
    iptables -I INPUT -p tcp --dport 80 -j ACCEPT
    iptables -I INPUT -p tcp --dport 443 -j ACCEPT
    iptables -I INPUT -p tcp --dport 8080 -j ACCEPT
    iptables -I INPUT -p tcp --dport 9800 -j ACCEPT
    iptables -I INPUT -p tcp --dport 3478 -j ACCEPT
    iptables -I INPUT -p udp --dport 3478 -j ACCEPT
    iptables -I INPUT -p tcp --dport 5349 -j ACCEPT
    iptables -I INPUT -p udp --dport 5349 -j ACCEPT
    iptables -I INPUT -p udp --dport 49152:49252 -j ACCEPT
    echo "  iptables rules applied"
fi

# ──── Step 4: Configure Coturn ────
print_step "Configuring TURN server..."
sed -i "s|EXTERNAL_IP_PLACEHOLDER|${PUBLIC_IP}|g" "${SCRIPT_DIR}/coturn/turnserver.conf"
echo "  TURN external IP set to ${PUBLIC_IP}"

# ──── Step 5: Configure Nginx ────
print_step "Configuring Nginx for ${DOMAIN}..."
sed -i "s|DOMAIN_PLACEHOLDER|${DOMAIN}|g" "${SCRIPT_DIR}/nginx/conf.d/fasttransfer.conf"
echo "  Nginx configured"

# ──── Step 6: Create .env ────
print_step "Writing environment config..."
cat > "${SCRIPT_DIR}/.env" <<EOF
DOMAIN=${DOMAIN}
PUBLIC_IP=${PUBLIC_IP}
TURN_HOST=${PUBLIC_IP}
TURN_SECRET=${TURN_SECRET}
DUCKDNS_SUBDOMAIN=${DUCKDNS_SUBDOMAIN}
DUCKDNS_TOKEN=${DUCKDNS_TOKEN}
EMAIL=${EMAIL}
EOF
echo "  .env created"

# ──── Step 7: Start HTTP services ────
print_step "Building and starting services (HTTP first)..."
cd "${SCRIPT_DIR}"
docker compose up --build -d fasttransfer nginx
echo "  Waiting for services to start..."
sleep 8

# Quick health check
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/ 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
    echo "  Go server is healthy (HTTP 200)"
else
    echo -e "  ${YELLOW}Go server returned HTTP ${HTTP_CODE} — check logs: docker compose logs fasttransfer${NC}"
fi

# ──── Step 8: SSL Certificate ────
print_step "Obtaining SSL certificate..."

# Create certbot webroot
mkdir -p /var/www/certbot

docker compose run --rm certbot certonly \
    --webroot \
    --webroot-path=/var/www/certbot \
    --email "${EMAIL}" \
    --agree-tos \
    --no-eff-email \
    -d "${DOMAIN}" 2>&1 && SSL_OK=true || SSL_OK=false

if [ "$SSL_OK" = true ]; then
    echo "  SSL certificate obtained!"

    # Enable HTTPS in Nginx
    print_step "Enabling HTTPS..."
    sed -i '/^# SSL_START/,/^# SSL_END/{s/^# //}' "${SCRIPT_DIR}/nginx/conf.d/fasttransfer.conf"

    # Enable TLS in Coturn
    sed -i "s|# cert=/etc/letsencrypt/live/DOMAIN|cert=/etc/letsencrypt/live/${DOMAIN}|" "${SCRIPT_DIR}/coturn/turnserver.conf"
    sed -i "s|# pkey=/etc/letsencrypt/live/DOMAIN|pkey=/etc/letsencrypt/live/${DOMAIN}|" "${SCRIPT_DIR}/coturn/turnserver.conf"
    echo "  HTTPS enabled"
else
    print_warn "SSL failed — site will work on HTTP. Common causes:"
    echo "  - DNS not propagated yet (wait 2-3 min, then rerun)"
    echo "  - Port 80 not open in Azure NSG"
    echo "  Retry: docker compose run --rm certbot certonly --webroot --webroot-path=/var/www/certbot -d ${DOMAIN}"
fi

# ──── Step 9: Start everything ────
print_step "Starting all services..."
cd "${SCRIPT_DIR}"
docker compose up --build -d
sleep 5

# ──── Step 10: Final verification ────
print_step "Verifying deployment..."
echo ""

check_url() {
    local label=$1 url=$2
    local code=$(curl -s -o /dev/null -w "%{http_code}" "$url" 2>/dev/null || echo "ERR")
    if [ "$code" = "200" ] || [ "$code" = "301" ] || [ "$code" = "302" ]; then
        echo -e "  ${GREEN}OK${NC}  ${label}: ${url} (${code})"
    else
        echo -e "  ${YELLOW}--${NC}  ${label}: ${url} (${code})"
    fi
}

check_url "HTTP " "http://${DOMAIN}"
check_url "HTTPS" "https://${DOMAIN}"
check_url "API  " "http://${DOMAIN}/api/turn"

echo ""
echo "  ╔═══════════════════════════════════════════════════════════╗"
echo "  ║                  Deployment Complete!                      ║"
echo "  ╠═══════════════════════════════════════════════════════════╣"
echo "  ║                                                            ║"
echo "  ║  Web App:     http://${DOMAIN}"
if [ "$SSL_OK" = true ]; then
echo "  ║  Web App:     https://${DOMAIN}"
fi
echo "  ║  TURN Server: ${PUBLIC_IP}:3478"
echo "  ║  TCP Relay:   ${PUBLIC_IP}:9800"
echo "  ║                                                            ║"
echo "  ║  Rust CLI:                                                 ║"
echo "  ║    fasttransfer -s http://${DOMAIN} send myfile.zip"
echo "  ║    fasttransfer -s http://${DOMAIN} receive CODE"
echo "  ║                                                            ║"
echo "  ║  Commands:                                                 ║"
echo "  ║    docker compose logs -f       (watch logs)               ║"
echo "  ║    docker compose restart       (restart)                  ║"
echo "  ║    docker compose down          (stop)                     ║"
echo "  ║                                                            ║"
echo "  ╚═══════════════════════════════════════════════════════════╝"
echo ""
