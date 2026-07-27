# Volmex module

Streams Volmex volatility index prices over a Socket.IO WebSocket and serves the latest cached value for requested symbols. Routes can also proxy authenticated REST requests.

## Overview

On startup the module:

1. Connects with `socket.io-client`.
2. Authenticates with a JWT passed as the `jwtToken` query parameter.
3. On `connect` (including after auto-reconnect), subscribes via `fetch-indices-messages-private`.
4. Caches every `indices-messages-stream-private` message by `symbol`.
5. Relies on Socket.IO client reconnection (`reconnection: true`, delay from `reconnectDelayMs`).

HTTP requests are handled based on the route `source`:

- **`ws`** — resolve symbols from `fetchFromModule` and return the latest cached price for each. If a price is not yet available, the handler waits briefly (shared price-cache timeout: 3 seconds).
- **`rest`** — proxy the inbound request to `restBaseUrl` + `upstreamPath` with the module JWT as `Authorization: Bearer …`, forwarding allowed query params.

Unlike subscription-based modules, Volmex keeps the latest price for **all** symbols on the stream. The stream is small (on the order of tens of indices / ~50 messages per second), so filtering/idle cleanup is not used.

## Configuration

### Module

| Field | Required | Default | Description |
| --- | --- | --- | --- |
| `type` | yes | — | Must be `"volmex"`. |
| `name` | yes | — | Module name referenced by routes as `moduleName`. |
| `volmexApiKeyEnvKey` | yes | — | Env var that holds the Volmex JWT. |
| `wsBaseUrl` | no | `wss://ws-8jh89.volmex.finance` | WebSocket base URL (no trailing slash required). |
| `restBaseUrl` | no | `https://private-multiregion-8jh89.volmex.finance` | REST API base URL for `source: "rest"` routes. |
| `maxSymbolsPerRequest` | no | `100` | Max symbols allowed in a single WS request. |
| `reconnectDelayMs` | no | `1000` | Passed to Socket.IO as `reconnectionDelay` (ms between reconnect attempts). |
| `restFetchTimeout` | no | `15 seconds` | Timeout for REST proxy fetches (`number` ms or duration string). |

### Route (WebSocket)

| Field | Required | Description |
| --- | --- | --- |
| `type` | yes | Must be `"volmex"`. |
| `moduleName` | yes | Name of a configured Volmex module. |
| `path` | yes | Proxy path (supports `{:param}` path params). |
| `method` | no | HTTP method(s); default is `GET`. |
| `source` | yes | Must be `"ws"` for live cache lookups. |
| `fetchFromModule` | yes | Template producing one or more comma-separated index symbols. |

### Route (REST proxy)

| Field | Required | Description |
| --- | --- | --- |
| `type` | yes | Must be `"volmex"`. |
| `moduleName` | yes | Name of a configured Volmex module. |
| `path` | yes | Proxy path (supports path params). |
| `method` | no | HTTP method(s); default is `GET`. |
| `source` | yes | Must be `"rest"`. |
| `upstreamPath` | yes | Upstream path relative to module `restBaseUrl`. Supports `{:param}` templates. |
| `allowedQueryParams` | no | When set, only these inbound query keys are forwarded upstream. |

### Example

```jsonc
{
  "modules": [
    {
      "type": "volmex",
      "name": "volmex",
      "wsBaseUrl": "wss://ws-8jh89.volmex.finance",
      "restBaseUrl": "https://private-multiregion-8jh89.volmex.finance",
      "volmexApiKeyEnvKey": "VOLMEX_API_KEY"
    }
  ],
  "routes": [
    {
      "type": "volmex",
      "moduleName": "volmex",
      "source": "ws",
      "path": "/:priceSymbol",
      "method": "GET",
      "fetchFromModule": "{:priceSymbol}"
    },
    {
      "type": "volmex",
      "moduleName": "volmex",
      "source": "rest",
      "path": "/history",
      "method": "GET",
      "upstreamPath": "/public/history",
      "allowedQueryParams": ["symbol", "resolution", "from", "to"]
    }
  ]
}
```

```bash
# Single symbol (WS cache)
curl -X GET "http://127.0.0.1:5384/proxy/BVIV" | jq .

# Multiple symbols (comma-separated)
curl -X GET "http://127.0.0.1:5384/proxy/BVIV,EVIV,SVIV" | jq .

# Historical bars (REST proxy)
# Use -G so --data-urlencode becomes query params (GET body is ignored by the proxy)
curl -sG "http://127.0.0.1:5384/proxy/history" \
  --data-urlencode "symbol=BVIV" \
  --data-urlencode "resolution=D" \
  --data-urlencode "from=1700000000" \
  --data-urlencode "to=1701000000" | jq .
```

## Response shape

### WebSocket routes

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

### REST routes

The upstream status, body, and content type are returned as-is (true proxy). Timeouts map to HTTP 504; transport failures to HTTP 502.

## Notes

- Obtain a JWT from Volmex auth (for example `POST https://rest-v1.volmex.finance/auth/authorize`) and set it in the env var named by `volmexApiKeyEnvKey`.
- Volmex docs: https://private-multiregion-8jh89.volmex.finance/api
