#!/bin/sh

if [ -f "/app/config.json" ] && [ -f "/app/data-proxy-private-key.json" ]; then
  echo "Config and private key files found. Running with specific configuration."
  exec ./dataproxy run --config /app/config.json --private-key-file /app/data-proxy-private-key.json "$@"
else
  echo "Config or private key file not found. Running with default configuration."
  exec ./dataproxy run "$@"
fi
