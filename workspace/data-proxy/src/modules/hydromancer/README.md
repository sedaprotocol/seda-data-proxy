# Hydromancer module

Caches Hydromancer `activeAssetCtx` updates over WebSocket and serves `assetContext` requests from cache, falling back to a REST endpoint when data is missing or stale. Non-`assetContext` bodies are forwarded to upstream REST as-is.

## Overview

On startup the module:

1. Connects to `wsUrl` with the API key as a `token` query parameter.
2. Subscribes to every coin in `subscriptionCoins`.
3. Caches inbound `activeAssetCtx` frames by coin.
4. Idle-unsubscribes coins that have not been requested within `coinsCleanupTtl` (demand-driven subscriptions from HTTP requests are cleaned up the same way).

For `assetContext` HTTP requests the handler:

1. Parses a single-coin (`coin`) or batch (`coins`) body.
2. Expands comma-separated values in `coins` (string or string array) into individual tickers (so multi-route path params like `BTC,ETH` work after template substitution). The singular `coin` field is never expanded.
3. Subscribes to each coin over WebSocket (idempotent).
4. Serves fresh cache entries when the socket is healthy; otherwise (or on miss) batches a REST `POST /info` for the remaining coins.

Requests with more coins than `maxCoinsPerRequest` return HTTP 400.

## Environment variables

Set the env var named by `hydromancerApiKeyEnvKey`. Config parsing fails if it is unset; the value is treated as a secret and redacted from logs.

| Variable (example) | Purpose |
| --- | --- |
| `HYDROMANCER_API_KEY_MAINNET` | Bearer token for WS auth and REST `Authorization` |

## Configuration

### Module

| Field | Required | Default | Description |
| --- | --- | --- | --- |
| `type` | yes | — | Must be `"hydromancer"`. |
| `name` | yes | — | Module name referenced by routes as `moduleName`. |
| `wsUrl` | yes | — | WebSocket URL (e.g. `wss://api.hydromancer.xyz/ws`). |
| `restBaseUrl` | yes | — | REST base URL (e.g. `https://api.hydromancer.xyz`). |
| `hydromancerApiKeyEnvKey` | yes | — | Env var that holds the Hydromancer API key. |
| `subscriptionCoins` | no | `[]` | Coins to subscribe to on start. |
| `staleAfter` | no | `"10 seconds"` | Max age of a cached ctx before REST refresh. |
| `maxCoinsPerRequest` | no | `20` | Max coins allowed in a single `assetContext` request. |
| `coinsCleanupTtl` | no | `"1 hour"` | Idle time before an unused subscription is cleaned up. |
| `coinsCleanupInterval` | no | `"30 seconds"` | How often idle cleanup runs. |
| `reconnectMaxBackoff` | no | `"30 seconds"` | Cap on WS reconnect backoff. |
| `reconnectStableThreshold` | no | `"30 seconds"` | Connected duration before reconnect backoff resets. |
| `restFetchTimeout` | no | `"15 seconds"` | Timeout for REST `/info` calls. |

### Route

Hydromancer routes do not use `fetchFromModule`. The request body is the Hydromancer `/info` payload.

| Field | Required | Description |
| --- | --- | --- |
| `type` | yes | Must be `"hydromancer"`. |
| `moduleName` | yes | Name of a configured Hydromancer module. |
| `path` | yes | Proxy path (supports `{:param}` path params). |
| `method` | no | HTTP method(s); typically `POST` for standalone routes that accept a body. |

### Example

```jsonc
{
  "modules": [
    {
      "type": "hydromancer",
      "name": "hydro",
      "wsUrl": "wss://api.hydromancer.xyz/ws",
      "restBaseUrl": "https://api.hydromancer.xyz",
      "hydromancerApiKeyEnvKey": "HYDROMANCER_API_KEY_MAINNET",
      "subscriptionCoins": ["BTC", "ETH"]
    }
  ],
  "routes": [
    {
      "type": "hydromancer",
      "moduleName": "hydro",
      "path": "/hydro",
      "method": ["POST"]
    }
  ]
}
```

```bash
# Single coin — response is one AssetCtx object (or null)
curl -s "http://127.0.0.1:5384/proxy/hydro" \
  -H 'Content-Type: application/json' \
  -d '{"type":"assetContext","coin":"BTC"}' | jq .

# Batch — response is a map of coin → AssetCtx | null
curl -s "http://127.0.0.1:5384/proxy/hydro" \
  -H 'Content-Type: application/json' \
  -d '{"type":"assetContext","coins":["BTC","ETH"]}' | jq .

# Comma-delimited string (expanded to BTC and ETH; batch response shape)
curl -s "http://127.0.0.1:5384/proxy/hydro" \
  -H 'Content-Type: application/json' \
  -d '{"type":"assetContext","coins":"BTC,ETH"}' | jq .
```

### Multi-route fetch

On a `multi` route, set `body` to an `assetContext` template. Path params are substituted with `{:param}`:

```jsonc
{
  "type": "multi",
  "path": "/multi/:symbols/:markets/:hydroTickers",
  "method": ["GET"],
  "fetches": [
    {
      "name": "hydromancer",
      "moduleName": "hydro",
      "type": "hydromancer",
      "body": "{\"type\":\"assetContext\",\"coins\":\"{:hydroTickers}\"}"
    }
  ]
}
```

```bash
# hydroTickers becomes coins:"BTC,ETH", then expanded to BTC and ETH
curl -s "http://127.0.0.1:5384/proxy/multi/BTCUSDT,ETHUSDT/1,2/BTC,ETH" | jq .
```

## Request body

| Shape | Behavior |
| --- | --- |
| `{"type":"assetContext","coin":"..."}` | Single-coin path. Response is one `AssetCtx` (or `null`). The value is used as-is (no comma expansion). |
| `{"type":"assetContext","coins":["...", "..."]}` | Batch path. Response is `{ [coin]: AssetCtx \| null }`. Comma-separated entries inside the array are expanded. |
| `{"type":"assetContext","coins":"BTC,ETH"}` | Same batch path; a comma-delimited string is expanded to individual tickers. |
| Anything else | Forwarded unchanged to `POST {restBaseUrl}/info` with the bearer token. |

## Response shape

### Single (`coin`)

```jsonc
{
  "oraclePx": "...",
  "markPx": "...",
  "midPx": "...",
  "impactPxs": ["...", "..."],
  "openInterest": "..."
}
```

Fields may be `null`. If the coin cannot be resolved, the body is `null`.

### Batch (`coins`)

```jsonc
{
  "BTC": { "oraclePx": "...", "markPx": "...", "midPx": "...", "impactPxs": [...], "openInterest": "..." },
  "ETH": null
}
```

Unresolved coins stay `null`, matching Hydromancer’s native `/info` batch shape.
