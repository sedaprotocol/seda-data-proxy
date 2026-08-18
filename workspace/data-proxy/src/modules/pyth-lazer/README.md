# Pyth Lazer module

Streams Pyth Lazer price feeds over a redundant WebSocket pool and serves the latest cached value for requested feed IDs or symbols.

## Overview

On startup the module:

1. Creates a `PythLazerClient` with a pool of WebSocket connections to Pyth Lazer.
2. Adds every entry in `priceFeedIds` to the per-channel desired set and sends one subscribe per channel.
3. Caches inbound `streamUpdated` messages keyed by `(channel, priceFeedId)`. Ticks for feeds that are no longer in the desired set are ignored.
4. A forked cleanup daemon removes from the desired set feeds that have not been requested within `priceFeedsCleanupTtl`. It deletes their cache entries and updates the desired set.

HTTP requests resolve `fetchFromModule` to one or more comma-separated feed IDs or symbols, add any new feeds to the desired set, send a subscribe of the full set for that channel if it grew, and return the latest cached price for each. If a price is not yet available, the handler waits briefly for an update (shared price-cache timeout: 3 seconds).

Pyth cannot append feeds to an existing subscription id, so a grow sends a **new** subscribe with a new id and the full desired set for that channel. Each channel has at most one **active** (acked) subscription, plus any in-flight ids still waiting for an ack. The module promotes an id only after Pyth acks it (`subscribed` or `subscribedWithInvalidFeedIdsIgnored`) and only if it is higher than the channel’s current active id; older outstanding ids on that channel are then unsubscribed.

## Configuration

### Module

| Field | Required | Default | Description |
| --- | --- | --- | --- |
| `type` | yes | — | Must be `"pyth-lazer"`. |
| `name` | yes | — | Module name referenced by routes as `moduleName`. |
| `pythLazerApiKeyEnvKey` | yes | — | Env var that holds the Pyth Lazer API token. |
| `priceFeedIds` | yes | — | Feeds to subscribe to on start. Each entry: `name`, `id`, optional `channel` (`fixed_rate@200ms` if omitted). |
| `maxFeedsPerRequest` | no | `100` | Max feed IDs / symbols allowed in a single request. |
| `priceFeedsCleanupTtl` | no | `"1 hour"` | Idle time before an unused price feed is cleaned up. |
| `priceFeedsCleanupInterval` | no | `"30 seconds"` | How often idle cleanup runs. |

### Route

| Field | Required | Default | Description |
| --- | --- | --- | --- |
| `type` | yes | — | Must be `"pyth-lazer"`. |
| `moduleName` | yes | — | Name of a configured Pyth Lazer module. |
| `path` | yes | — | Proxy path (supports `{:param}` path params). |
| `method` | no | `GET` | HTTP method(s). |
| `fetchFromModule` | yes | — | Template producing one or more comma-separated feed IDs or symbols. |
| `channel` | no | `fixed_rate@200ms` | Channel for this route’s subscriptions and cache lookups (`real_time`, `fixed_rate@50ms`, `fixed_rate@200ms`, `fixed_rate@1000ms`). |

### Multi-route fetch

When a `multi` route targets this module, each fetch may set its own `channel` (defaults to `fixed_rate@200ms` if omitted):

```jsonc
{
  "type": "multi",
  "path": "/:symbol",
  "fetches": [
    {
      "name": "pyth_200ms",
      "moduleName": "pyth",
      "type": "pyth-lazer",
      "fetchFromModule": "{:symbol}" // default (fixed_rate@200ms)
    },
    {
      "name": "pyth_realtime",
      "moduleName": "pyth",
      "type": "pyth-lazer",
      "fetchFromModule": "{:symbol}",
      "channel": "real_time" // overrides the default
    }
  ]
}
```

### Example Configuration

```jsonc
{
  "modules": [
    {
      "type": "pyth-lazer",
      "name": "pyth",
      "pythLazerApiKeyEnvKey": "PYTH_LAZER_API_KEY",
      "priceFeedIds": [
        { "name": "BTC/USD", "id": 1 },
        { "name": "ETH/USD", "id": 2, "channel": "real_time" }
      ]
    }
  ],
  "routes": [
    {
      "type": "pyth-lazer",
      "moduleName": "pyth",
      "path": "/200ms/:symbol",
      "method": "GET",
      "fetchFromModule": "{:symbol}",
      "channel": "fixed_rate@200ms"
    },
    {
      "type": "pyth-lazer",
      "moduleName": "pyth",
      "path": "/realtime/:symbol",
      "method": "GET",
      "fetchFromModule": "{:symbol}",
      "channel": "real_time"
    }
  ]
}
```


## Request and Response

Example requests against the example configuration above:

```bash
# Feed ID on fixed_rate@200ms
curl -s "http://127.0.0.1:5384/proxy/200ms/1" | jq .

# Same feed on real_time
curl -s "http://127.0.0.1:5384/proxy/realtime/1" | jq .

# Symbol (resolved via Pyth metadata)
curl -s "http://127.0.0.1:5384/proxy/200ms/Crypto.BTC%2FUSD" | jq .

# Multiple feeds (comma-separated)
curl -s "http://127.0.0.1:5384/proxy/200ms/1,2" | jq .
```

Successful responses are a JSON array. Example for `GET /proxy/200ms/1,2`:

```json
[
  {
    "priceFeedId": 1,
    "price": "6657080819622",
    "bestBidPrice": "6656513616670",
    "bestAskPrice": "6657472370813",
    "publisherCount": 19,
    "exponent": -8,
    "confidence": 2188501708,
    "marketSession": "regular",
    "emaPrice": "6648715700000",
    "emaConfidence": 1953158920,
    "feedUpdateTimestamp": 1784678955400000,
    "symbol": "1",
    "__sedaHasPrice": true
  },
  {
    "priceFeedId": 2,
    "price": "193228893674",
    "bestBidPrice": "193227483680",
    "bestAskPrice": "193255500075",
    "publisherCount": 20,
    "exponent": -8,
    "confidence": 48018423,
    "marketSession": "regular",
    "emaPrice": "192356325000",
    "emaConfidence": 64887569,
    "feedUpdateTimestamp": 1784678955800000,
    "symbol": "2",
    "__sedaHasPrice": true
  }
]
```

On a wait timeout, the entry still appears with `__sedaHasPrice: false` and without price fields:

```json
{
  "priceFeedId": 77777,
  "symbol": "77777",
  "__sedaHasPrice": false
}
```

| Field | Present when | Description |
| --- | --- | --- |
| `priceFeedId` | always | Numeric Pyth Lazer feed ID. |
| `symbol` | always | The raw request token (ID or symbol string from `fetchFromModule`). |
| Pyth feed fields | `__sedaHasPrice: true` | Fields from the stream (`price`, `bestBidPrice`, `bestAskPrice`, `exponent`, `confidence`, funding / EMA fields, etc.). |
| `__sedaHasPrice` | always | `true` when a cached price was returned; `false` on wait timeout / miss. |

Requests with more feeds than `maxFeedsPerRequest`, or a numeric token that is not a u32, return HTTP 400.


## Notes

- Numeric request tokens are treated as feed IDs and must be a u32; non-numeric tokens are resolved to IDs via the Pyth metadata service (concurrently per request) and cached in-process until the feed idles out on every channel.
- Pyth Lazer docs: https://docs.pyth.network/lazer
