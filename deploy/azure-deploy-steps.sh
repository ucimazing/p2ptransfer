#!/bin/bash
# ============================================================
# FastTransfer — Azure Deployment Steps
# Run these commands in order from your LOCAL machine.
# Prerequisites: Azure CLI installed (brew install azure-cli)
# ============================================================

# ──── Step 1: Login to Azure ────
# az login

# ──── Step 2: Get your VM's public IP ────
echo "=== Your VM's Public IP ==="
az vm show -g transfer_group -n transfer --show-details --query publicIps -o tsv

# ──── Step 3: Find your NSG name ────
echo ""
echo "=== Network Security Group ==="
az network nsg list -g transfer_group --query "[].name" -o tsv

# ──── Step 4: Open all required ports ────
# Replace YOUR_NSG_NAME with the output from Step 3
NSG_NAME=$(az network nsg list -g transfer_group --query "[0].name" -o tsv)
RG="transfer_group"

echo ""
echo "=== Opening ports in NSG: ${NSG_NAME} ==="

az network nsg rule create -g "$RG" --nsg-name "$NSG_NAME" \
    --name AllowHTTP --priority 1001 \
    --destination-port-ranges 80 --protocol TCP \
    --access Allow --direction Inbound -o none && echo "  Opened TCP 80 (HTTP)"

az network nsg rule create -g "$RG" --nsg-name "$NSG_NAME" \
    --name AllowHTTPS --priority 1002 \
    --destination-port-ranges 443 --protocol TCP \
    --access Allow --direction Inbound -o none && echo "  Opened TCP 443 (HTTPS)"

az network nsg rule create -g "$RG" --nsg-name "$NSG_NAME" \
    --name AllowGoServer --priority 1003 \
    --destination-port-ranges 8080 --protocol TCP \
    --access Allow --direction Inbound -o none && echo "  Opened TCP 8080 (Go server)"

az network nsg rule create -g "$RG" --nsg-name "$NSG_NAME" \
    --name AllowRelay --priority 1004 \
    --destination-port-ranges 9800 --protocol TCP \
    --access Allow --direction Inbound -o none && echo "  Opened TCP 9800 (CLI relay)"

az network nsg rule create -g "$RG" --nsg-name "$NSG_NAME" \
    --name AllowTURN --priority 1005 \
    --destination-port-ranges 3478 --protocol '*' \
    --access Allow --direction Inbound -o none && echo "  Opened TCP/UDP 3478 (TURN)"

az network nsg rule create -g "$RG" --nsg-name "$NSG_NAME" \
    --name AllowTURNTLS --priority 1006 \
    --destination-port-ranges 5349 --protocol '*' \
    --access Allow --direction Inbound -o none && echo "  Opened TCP/UDP 5349 (TURN TLS)"

az network nsg rule create -g "$RG" --nsg-name "$NSG_NAME" \
    --name AllowTURNRelay --priority 1007 \
    --destination-port-ranges 49152-49252 --protocol UDP \
    --access Allow --direction Inbound -o none && echo "  Opened UDP 49152-49252 (TURN relay)"

echo ""
echo "=== All ports opened. Verify: ==="
az network nsg rule list -g "$RG" --nsg-name "$NSG_NAME" --query "[?direction=='Inbound']" -o table
