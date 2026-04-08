#!/bin/bash
set -e

# ============================================================
# FastTransfer — Azure NSG (Network Security Group) Setup
#
# Run this from your LOCAL machine (not the VM).
# Requires: Azure CLI (az) installed and logged in.
#
# Usage: ./azure-nsg.sh <resource-group> <nsg-name>
# Example: ./azure-nsg.sh fasttransfer-rg fasttransfer-nsg
#
# To find your NSG name:
#   az network nsg list --resource-group YOUR_RG -o table
# ============================================================

RG="${1:-}"
NSG="${2:-}"

if [ -z "$RG" ] || [ -z "$NSG" ]; then
    echo "Usage: ./azure-nsg.sh <resource-group> <nsg-name>"
    echo ""
    echo "Find your resource group and NSG:"
    echo "  az group list -o table"
    echo "  az network nsg list -o table"
    exit 1
fi

echo "Opening ports in NSG: ${NSG} (Resource Group: ${RG})"
echo ""

# HTTP
echo "  Opening TCP 80 (HTTP)..."
az network nsg rule create --resource-group "$RG" --nsg-name "$NSG" \
    --name AllowHTTP --priority 1001 \
    --destination-port-ranges 80 --protocol TCP \
    --access Allow --direction Inbound -o none

# HTTPS
echo "  Opening TCP 443 (HTTPS)..."
az network nsg rule create --resource-group "$RG" --nsg-name "$NSG" \
    --name AllowHTTPS --priority 1002 \
    --destination-port-ranges 443 --protocol TCP \
    --access Allow --direction Inbound -o none

# Go server (direct access, useful for testing)
echo "  Opening TCP 8080 (Go server)..."
az network nsg rule create --resource-group "$RG" --nsg-name "$NSG" \
    --name AllowGoServer --priority 1003 \
    --destination-port-ranges 8080 --protocol TCP \
    --access Allow --direction Inbound -o none

# TCP relay for Rust CLI
echo "  Opening TCP 9800 (CLI relay)..."
az network nsg rule create --resource-group "$RG" --nsg-name "$NSG" \
    --name AllowRelay --priority 1004 \
    --destination-port-ranges 9800 --protocol TCP \
    --access Allow --direction Inbound -o none

# TURN server (TCP + UDP)
echo "  Opening TCP/UDP 3478 (TURN)..."
az network nsg rule create --resource-group "$RG" --nsg-name "$NSG" \
    --name AllowTURN --priority 1005 \
    --destination-port-ranges 3478 --protocol '*' \
    --access Allow --direction Inbound -o none

# TURN TLS
echo "  Opening TCP/UDP 5349 (TURN TLS)..."
az network nsg rule create --resource-group "$RG" --nsg-name "$NSG" \
    --name AllowTURNTLS --priority 1006 \
    --destination-port-ranges 5349 --protocol '*' \
    --access Allow --direction Inbound -o none

# TURN relay ports
echo "  Opening UDP 49152-49252 (TURN relay)..."
az network nsg rule create --resource-group "$RG" --nsg-name "$NSG" \
    --name AllowTURNRelay --priority 1007 \
    --destination-port-ranges 49152-49252 --protocol UDP \
    --access Allow --direction Inbound -o none

echo ""
echo "All ports opened. Verify with:"
echo "  az network nsg rule list --resource-group $RG --nsg-name $NSG -o table"
echo ""
