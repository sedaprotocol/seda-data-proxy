# Ticker module

Shared HTTP + cache + idle-cleanup loop for string-keyed public ticker venues. Each module supplies only its WebSocket protocol; request handling, price caching, and subscription lifecycle are the same.

## Overview

On startup each venue module:

1. Connects to `wsUrl`.
2. Subscribes to every symbol in `subscriptionSymbols`.
3. Caches inbound ticker frames by uppercased symbol.
4. Sets up an idle cleanup loop to unsubscribe symbols that have not been requested within `symbolsCleanupTtl`.

For HTTP requests the handler:

1. Resolves `fetchFromModule` to one or more comma-separated symbols.
2. Rejects the request with HTTP 400 if the count exceeds `maxSymbolsPerRequest`.
3. Subscribes to any new symbols over WebSocket.
4. Returns the latest cached frame for each symbol. If a price is not yet available, the handler waits briefly (shared price-cache timeout: 3 seconds).

While the socket is disconnected or errored, every item is returned with `__sedaHasPrice: false` even if a stale frame is still in cache.

## Configuration

### Shared module fields

Duration fields accept a number (ms) or a duration string (`"30 seconds"`).

| Field | Required | Default | Description |
| --- | --- | --- | --- |
| `type` | yes | — | `"binance"` |
| `name` | yes | — | Module name referenced by routes as `moduleName`. |
| `wsUrl` | no | venue default (below) | Public WebSocket URL. |
| `subscriptionSymbols` | no | `[]` | Symbols to subscribe to on start. |
| `maxSymbolsPerRequest` | no | `100` | Max symbols allowed in a single request. |
| `maxMessagesPerSecond` | no | venue default (below) | Cap on outbound WS control frames per second. |
| `symbolsCleanupTtl` | no | `"1 hour"` | Idle time before an unused subscription is cleaned up. |
| `symbolsCleanupInterval` | no | `"30 seconds"` | How often idle cleanup runs. |
| `reconnectMaxBackoff` | no | `"30 seconds"` | Cap on WS reconnect backoff. |
| `reconnectStableThreshold` | no | `"30 seconds"` | Connected duration before reconnect backoff resets. |

### Venue-specific fields

| Venue | Default `wsUrl` | Default `maxMessagesPerSecond` | Extra fields |
| --- | --- | --- | --- |
| Binance | `wss://stream.binance.com:9443/stream` | `5` | `streamType` (default `"bookTicker"`): `bookTicker`, `aggTrade`, `trade`, `ticker`, `miniTicker`. No keepalive. |
| OKX | `wss://ws.okx.com:8443/ws/v5/public` | `480` / `"1 hour"` | `keepaliveInterval` (default `"20 seconds"`). |
| Bybit | `wss://stream.bybit.com/v5/public/spot` | `5` / `"1 second"` | `keepaliveInterval` (default `"15 seconds"`). |

### Route

| Field | Required | Description |
| --- | --- | --- |
| `type` | yes | Must match the module (`"binance"`, `"bybit"`, or `"okx"`). |
| `moduleName` | yes | Name of a configured ticker module. |
| `path` | yes | Proxy path (supports `{:param}` path params). |
| `method` | no | HTTP method(s); typically `GET`. |
| `fetchFromModule` | yes | Template producing one or more comma-separated symbols. |

### Example

```jsonc
{
  "modules": [
    { "type": "binance", "name": "binance" },
    { "type": "okx", "name": "okx" },
    { "type": "bybit", "name": "bybit" }
  ],
  "routes": [
    {
      "type": "binance",
      "moduleName": "binance",
      "path": "/binance/:symbols",
      "method": ["GET"],
      "fetchFromModule": "{:symbols}"
    },
    {
      "type": "okx",
      "moduleName": "okx",
      "path": "/okx/:symbols",
      "method": ["GET"],
      "fetchFromModule": "{:symbols}"
    },
    {
      "type": "bybit",
      "moduleName": "bybit",
      "path": "/bybit/:symbols",
      "method": ["GET"],
      "fetchFromModule": "{:symbols}"
    }
  ]
}
```

```bash
curl -s "http://127.0.0.1:5384/proxy/binance/BTCUSDT,ETHUSDT" | jq .
curl -s "http://127.0.0.1:5384/proxy/okx/BTC-USDT,ETH-USDT" | jq .
curl -s "http://127.0.0.1:5384/proxy/bybit/BTCUSDT,ETHUSDT" | jq .
```

## Response shape

Successful responses are a JSON array in request order. Each item is the venue’s ticker payload plus an identity field and `__sedaHasPrice`.

Binance (`bookTicker`; identity field `symbol`):

```jsonc
[
  {
    "u": 400900217,
    "s": "BTCUSDT",
    "b": "67123.44",
    "B": "1.2",
    "a": "67123.46",
    "A": "0.8",
    "symbol": "BTCUSDT",
    "__sedaHasPrice": true
  },
  {
    "symbol": "DOGEUSDT",
    "__sedaHasPrice": false
  }
]
```

OKX (identity field `instId`):

```jsonc
[
  {
    "instId": "BTC-USDT",
    "last": "67123.4",
    "askPx": "67123.5",
    "bidPx": "67123.3",
    "__sedaHasPrice": true
  }
]
```

Bybit (identity field `symbol`):

```jsonc
[
  {
    "symbol": "BTCUSDT",
    "lastPrice": "76173.9",
    "highPrice24h": "78232.5",
    "lowPrice24h": "76000",
    "__sedaHasPrice": true
  }
]
```

| Field | Present when | Description |
| --- | --- | --- |
| Identity (`symbol` or `instId`) | always | The raw request token from `fetchFromModule` (original casing). |
| Venue ticker fields | `__sedaHasPrice: true` | Relayed verbatim from the stream. |
| `__sedaHasPrice` | always | `true` when a cached price was returned; `false` on wait timeout, miss, or unhealthy socket. |

Requests with more symbols than `maxSymbolsPerRequest` return HTTP 400.

## Adding a venue

For another string-keyed public ticker feed:

1. Add venue config with `tickerModuleBaseFields` (and keepalive / extra fields if needed).
2. Implement `parseInboundFrame`, subscribe/unsubscribe builders, and `createWS` via `createVenueWS`.
3. Wrap with `createTickerModuleService` (`venue`, `routeType`, `identityField`, `createWS`).
4. Register the module in `module-config.ts` and `proxy-server.ts`.

## Notes

- Symbols are uppercased for subscribe/cache keys; the identity field on the response keeps the request token as written.
- The first request for a new symbol may wait up to 3 seconds for the first tick; a miss still returns 200 with `__sedaHasPrice: false`.
- Binance docs: https://developers.binance.com/docs/binance-spot-api-docs/web-socket-streams
- OKX tickers channel: https://www.okx.com/docs-v5/en/#order-book-trading-market-data-ws-tickers-channel
- Bybit ticker stream: https://bybit-exchange.github.io/docs/v5/websocket/public/ticker
