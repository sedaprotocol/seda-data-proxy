# Hydromancer module

Caches Hydromancer `activeAssetCtx`, `l2Book`, or `trades` updates over WebSocket and serves requests from those caches. `assetContext` falls back to a REST endpoint when data is missing or stale. `l2Book` and `trades` have no REST fallback: the request waits briefly for the first update and returns `null` on timeout. Bodies that match none of these types are forwarded to upstream REST as-is.

## Overview

On startup the module:

1. Connects to `wsUrl` with the API key as a `token` query parameter.
2. Subscribes to every coin in `subscriptionCoins` (`activeAssetCtx`), `l2BookSubscriptionCoins` (`l2Book`), and `tradesSubscriptionCoins` (`trades`).
3. Caches inbound frames. The cache for `activeAssetCtx` frames is freshness-keyed, whereas the caches for `l2Book` and `trades` frames are waiter-keyed.
4. Idle-unsubscribes each channel independently based on `coinsCleanupTtl`, `l2BookCleanupTtl`, and `tradesCleanupTtl`.

For `assetContext` HTTP requests the handler:

1. Parses a single-coin (`coin`) or batch (`coins`) body.
2. Expands comma-separated values in `coins` (string or string array) into individual tickers (so multi-route path params like `BTC,ETH` work after template substitution). The singular `coin` field is never expanded.
3. Subscribes to each coin over WebSocket (idempotent).
4. Serves fresh cache entries when the socket is healthy; otherwise (or on miss) batches a REST `POST /info` for the remaining coins.

Requests with more coins than `maxCoinsPerRequest` return HTTP 400.

For `l2Book` HTTP requests the handler:

1. Parses a batch (`coins`) body. There is no single-coin `coin` field.
2. Expands comma-separated values inside the `coins` array into individual tickers (same path-param expansion as batch `assetContext`).
3. Subscribes to each coin over WebSocket (idempotent).
4. Returns the latest cached snapshot immediately when present; otherwise waits up to `l2BookWaitTimeout` for the next inbound frame. A timeout or unsubscribe during the wait yields `null` for that coin.

There is no REST fallback for `l2Book`. Requests with more coins than `l2BookMaxCoinsPerRequest` return HTTP 400.

For `trades` HTTP requests the handler:

1. Parses a batch (`coins`) body. There is no single-coin `coin` field.
2. Expands comma-separated values inside `coins` into individual tickers (same path-param expansion as batch `assetContext`).
3. Subscribes to each coin over WebSocket (idempotent). Re-subscribing adds coins to the connection's single trades subscription.
4. Returns the cached recent trades for that coin immediately when present; otherwise waits up to `tradesWaitTimeout` for the next inbound frame. A timeout or unsubscribe during the wait yields `null` for that coin. Trades executed outside `tradesKeepSeconds` are dropped on cache write or when the request is served.

There is no REST fallback for `trades`, and the all-coins firehose is not used. Requests with more coins than `tradesMaxCoinsPerRequest` return HTTP 400.

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
| `subscriptionCoins` | no | `[]` | Coins to subscribe to `activeAssetCtx` on start. |
| `staleAfter` | no | `"10 seconds"` | Max age of a cached ctx before REST refresh. |
| `maxCoinsPerRequest` | no | `20` | Max coins allowed in a single `assetContext` request. |
| `coinsCleanupTtl` | no | `"1 hour"` | Idle time before an unused `activeAssetCtx` subscription is cleaned up. |
| `coinsCleanupInterval` | no | `"30 seconds"` | How often `activeAssetCtx` idle cleanup runs. |
| `l2BookSubscriptionCoins` | no | `[]` | Coins to subscribe to `l2Book` on start. |
| `l2BookMaxCoinsPerRequest` | no | `20` | Max coins allowed in a single `l2Book` request. |
| `l2BookNSigFigs` | no | — | Optional significant-figure aggregation sent on every `l2Book` subscribe frame. |
| `l2BookWaitTimeout` | no | `"1 second"` | How long an `l2Book` request waits for a snapshot before returning `null`. |
| `l2BookCleanupTtl` | no | `"2 minutes"` | Idle time before an unused `l2Book` subscription is cleaned up. |
| `l2BookCleanupInterval` | no | `"30 seconds"` | How often `l2Book` idle cleanup runs. |
| `tradesSubscriptionCoins` | no | `[]` | Coins to subscribe to `trades` on start. |
| `tradesMaxCoinsPerRequest` | no | `20` | Max coins allowed in a single `trades` request. |
| `tradesKeepSeconds` | no | `60` | How many seconds of executed trades to keep per coin. Older trades are dropped. |
| `tradesWaitTimeout` | no | `"1 second"` | How long a `trades` request waits for the first trade before returning `null`. |
| `tradesCleanupTtl` | no | `"2 minutes"` | Idle time before an unused `trades` subscription is cleaned up. |
| `tradesCleanupInterval` | no | `"30 seconds"` | How often `trades` idle cleanup runs. |
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
      "subscriptionCoins": ["BTC", "ETH"],
      "l2BookSubscriptionCoins": ["BTC", "ETH"],
      "tradesSubscriptionCoins": ["BTC", "ETH"]
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

# l2Book — response is a map of coin → BookSnapshot | null
curl -s "http://127.0.0.1:5384/proxy/hydro" \
  -H 'Content-Type: application/json' \
  -d '{"type":"l2Book","coins":["BTC","ETH"]}' | jq .

# trades — response is a map of coin → Trade[] | null
curl -s "http://127.0.0.1:5384/proxy/hydro" \
  -H 'Content-Type: application/json' \
  -d '{"type":"trades","coins":["BTC","ETH"]}' | jq .
```

## Request body

| Shape | Behavior |
| --- | --- |
| `{"type":"assetContext","coin":"..."}` | Single-coin path. Response is one `AssetCtx` (or `null`). The value is used as-is (no comma expansion). |
| `{"type":"assetContext","coins":["...", "..."]}` | Batch path. Response is `{ [coin]: AssetCtx \| null }`. Comma-separated entries inside the array are expanded. |
| `{"type":"assetContext","coins":"BTC,ETH"}` | Same batch path; a comma-delimited string is expanded to individual tickers. |
| `{"type":"l2Book","coins":["...", "..."]}` | Batch path. Response is `{ [coin]: BookSnapshot \| null }`. Comma-separated entries inside the array are expanded. There is no REST fallback; a miss waits up to `l2BookWaitTimeout` then returns `null`. |
| `{"type":"trades","coins":["...", "..."]}` | Batch path. Response is `{ [coin]: Trade[] \| null }`. Comma-separated entries inside the array are expanded. There is no REST fallback; a miss waits up to `tradesWaitTimeout` then returns `null`. |
| Anything else | Forwarded unchanged to `POST {restBaseUrl}/info` with the bearer token. |

## Response shape

### assetContext single (`coin`)

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

### assetContext batch (`coins`)

```jsonc
{
  "BTC": { "oraclePx": "...", "markPx": "...", "midPx": "...", "impactPxs": [...], "openInterest": "..." },
  "ETH": null
}
```

Unresolved coins stay `null`, matching Hydromancer’s native `/info` batch shape.

### l2Book (`coins`)

```jsonc
{
  "BTC": {
    "coin": "BTC",
    "levels": [
      [{ "px": "96000", "sz": "1.5", "n": 3 }],
      [{ "px": "96100", "sz": "2.0", "n": 5 }]
    ],
    "time": 1700000000000
  },
  "ETH": null
}
```

`levels` is `[bids, asks]`. Each level has `px` (price), `sz` (size), and `n` (number of orders). Unresolved coins (timeout, unsubscribe during wait, or no snapshot yet) stay `null`.

### trades (`coins`)

```jsonc
{
  "BTC": [
    {
      "coin": "BTC",
      "side": "B",
      "px": "62541.0",
      "sz": "0.0006",
      "hash": "0x...",
      "time": 1782203279565,
      "tid": 414334974001319,
      "users": ["0x...", "0x..."]
    }
  ],
  "ETH": null
}
```

Each entry matches Hydromancer's `WsTrade`. `side` is the taker's side (`"B"` bought, `"A"` sold). `users` is `[buyer, seller]`. `time` is a millisecond execution timestamp. Trades stay in arrival order; any trade older than `tradesKeepSeconds` is dropped. Unresolved coins stay `null`. A coin whose trades have all aged out is `[]`.
