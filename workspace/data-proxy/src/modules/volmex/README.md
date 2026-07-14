# Volmex module

Streams Volmex volatility index prices over a Socket.IO WebSocket and serves the latest cached value for requested symbols.

## Overview

On startup the module:

1. Connects with `socket.io-client`.
2. Authenticates with a JWT passed as the `jwtToken` query parameter.
3. On `connect` (including after auto-reconnect), subscribes via `fetch-indices-messages-private`.
4. Caches every `indices-messages-stream-private` message by `symbol`.
5. Relies on Socket.IO client reconnection (`reconnection: true`, delay from `reconnectDelayMs`).

HTTP requests resolve symbols from the route’s `fetchFromModule` template (comma-separated) and return the latest cached price for each symbol. If a price is not yet available, the handler waits briefly for an update (shared price-cache timeout: 3 seconds).

Unlike subscription-based modules, Volmex keeps the latest price for **all** symbols on the stream. The stream is small (on the order of tens of indices / ~50 messages per second), so filtering/idle cleanup is not used.

## Configuration

### Module

| Field | Required | Default | Description |
| --- | --- | --- | --- |
| `type` | yes | — | Must be `"volmex"`. |
| `name` | yes | — | Module name referenced by routes as `moduleName`. |
| `volmexApiKeyEnvKey` | yes | — | Env var that holds the Volmex JWT. |
| `baseUrl` | no | `wss://ws-8jh89.volmex.finance` | WebSocket base URL (no trailing slash required). |
| `maxSymbolsPerRequest` | no | `100` | Max symbols allowed in a single request. |
| `reconnectDelayMs` | no | `1000` | Passed to Socket.IO as `reconnectionDelay` (ms between reconnect attempts). |


### Route

| Field | Required | Description |
| --- | --- | --- |
| `type` | yes | Must be `"volmex"`. |
| `moduleName` | yes | Name of a configured Volmex module. |
| `path` | yes | Proxy path (supports `{:param}` path params). |
| `method` | no | HTTP method(s); default is `GET`. |
| `fetchFromModule` | yes | Template producing one or more comma-separated index symbols. |

### Example

```jsonc
{
  "modules": [
    {
      "type": "volmex",
      "name": "volmex",
      "baseUrl": "wss://ws-8jh89.volmex.finance",
      "volmexApiKeyEnvKey": "VOLMEX_API_KEY"
    }
  ],
  "routes": [
    {
      "type": "volmex",
      "moduleName": "volmex",
      "path": "/:priceSymbol",
      "method": "GET",
      "fetchFromModule": "{:priceSymbol}"
    }
  ]
}
```

```bash
# Single symbol
curl -s "http://127.0.0.1:5384/proxy/BVIV" | jq .

# Multiple symbols (comma-separated)
curl -s "http://127.0.0.1:5384/proxy/BVIV,EVIV,SVIV" | jq .
```

## Response shape

Successful responses are a JSON array. Each item is either a priced update or a miss:

```jsonc
[
  {
    "symbol": "BVIV",
    "price": 42.57,
    "timestamp": 1783951338255,
    "__sedaHasPrice": true
  },
  {
    "symbol": "UNKNOWN",
    "__sedaHasPrice": false
  }
]
```

| Field | Present when | Description |
| --- | --- | --- |
| `symbol` | always | Requested index symbol. |
| `price` | `__sedaHasPrice: true` | Latest streamed price. |
| `timestamp` | `__sedaHasPrice: true` | Source timestamp from Volmex (ms). |
| `__sedaHasPrice` | always | `true` when a cached price was returned; `false` on wait timeout / miss. |

Requests with more symbols than `maxSymbolsPerRequest` return HTTP 400.

## Notes

- Obtain a JWT from Volmex auth (for example `POST https://rest-v1.volmex.finance/auth/authorize`) and set it in the env var named by `volmexApiKeyEnvKey`.
- Volmex docs: https://private-multiregion-8jh89.volmex.finance/api
