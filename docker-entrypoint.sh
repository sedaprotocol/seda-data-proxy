#!/bin/bash

# Initialize flags for config.json and private key
CONFIG_EXISTS=false
PK_EXISTS=false

# Check if config.json exists
if [ -f /app/config.json ]; then
  echo "config.json detected"
  CONFIG_EXISTS=true
else
  echo "config.json not found"
fi

# Check if data-proxy-private-key.json exists
if [ -f /app/data-proxy-private-key.json ]; then
  echo "data-proxy-private-key.json detected"
  PK_EXISTS=true
elif [ -n "$SEDA_DATA_PROXY_PRIVATE_KEY" ]; then
  # If private key file does not exist, check if the private key is provided via environment variable
  echo "Private key provided via environment variable"
  echo "$SEDA_DATA_PROXY_PRIVATE_KEY" >/app/data-proxy-private-key.json
  PK_EXISTS=true
else
  echo "No private key provided"
fi

# Determine the command to run based on the presence of config.json and private key
if [ "$CONFIG_EXISTS" = true ] && [ "$PK_EXISTS" = true ]; then
  # Both config.json and private key are provided
  echo "Running with config and private key"
  RUN_CMD="bun start run --config /app/config.json --private-key-file /app/data-proxy-private-key.json"
elif [ "$CONFIG_EXISTS" = true ] && [ "$PK_EXISTS" = false ]; then
  # Only config.json is provided
  echo "Running with config only"
  RUN_CMD="bun start run --config /app/config.json"
else
  bun init
  # Neither config.json nor private key is provided
  echo "Running with --disable-proof"
  RUN_CMD="bun start run --disable-proof"
fi

# Execute the final command
exec $RUN_CMD
