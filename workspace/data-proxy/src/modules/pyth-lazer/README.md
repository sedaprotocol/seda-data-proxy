# Pyth Lazer module

Streams Pyth Lazer price feeds over a redundant WebSocket pool and serves the latest cached value for requested feed IDs or symbols.

## Overview

On startup the module:

1. Creates a `PythLazerClient` with a pool of WebSocket connections to Pyth Lazer.
2. Adds every entry in `priceFeedIds` to the per-channel desired set and sends one subscribe per channel.
3. Caches inbound `streamUpdated` messages keyed by `(channel, priceFeedId)`. Ticks for feeds that are no longer in the desired set are ignored.
4. A forked cleanup daemon removes from the desired set feeds that have not been requested within `priceFeedsCleanupTtl`. It deletes their cache entries and updates the desired set.

This module supports two different types of HTTP requests:

- **Standard Request** (`fetchFromModule` set): resolve the template to one or more comma-separated feed IDs or symbols, add any new feeds to the desired set for the route channel, send a subscribe of the full set for that channel if it grew, and return the latest cached price for each as a JSON array. If a price is not yet available, the handler waits briefly for an update (shared price-cache timeout: 3 seconds).
- **POST Body-Based Request** (`fetchFromModule` omitted): parse a JSON body (`priceFeedIds` / `priceFeedSymbols`, optional `channel`), subscribe on the selected channel (body overrides route default), and return `{ parsed: { timestampUs, priceFeeds } }`. All-or-fail if any feed misses.

Pyth cannot append feeds to an existing subscription id, so a grow sends a **new** subscribe with a new id and the full desired set for that channel. Each channel has at most one **active** (acked) subscription, plus any in-flight ids still waiting for an ack. The module promotes an id only after Pyth acks it (`subscribed` or `subscribedWithInvalidFeedIdsIgnored`) and only if it is higher than the channel’s current active id; older outstanding ids on that channel are then unsubscribed.

## Configuration

### Module

| Field | Required | Default | Description |
| --- | --- | --- | --- |
| `type` | yes | — | Must be `"pyth-lazer"`. |
| `name` | yes | — | Module name referenced by routes as `moduleName`. |
| `pythLazerApiKeyEnvKey` | yes | — | Env var that holds the Pyth Lazer API token. |
| `priceFeedIds` | no | `[{ name: "BTC/USD", id: 1 }]` on `fixed_rate@200ms` | Non-empty list of feeds to subscribe to on start. Each entry: `name`, `id` (u32), optional `channel` (`fixed_rate@200ms` if omitted). Omit to use the default BTC feed so the WebSocket pool stays active; an explicit empty list is rejected. |
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
| `fetchFromModule` | no | — | When set: Template producing one or more comma-separated feed IDs or symbols. When omitted: `POST` body is expected instead. |
| `channel` | no | `fixed_rate@200ms` | Default channel for this route’s subscriptions and cache lookups (`real_time`, `fixed_rate@50ms`, `fixed_rate@200ms`, `fixed_rate@1000ms`). On the Pro body surface, a request may override this with a `channel` field. |

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
    },
    {
      "type": "pyth-lazer",
      "moduleName": "pyth",
      "path": "/v1/latest_price",
      "method": "POST",
      "channel": "fixed_rate@200ms"
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

### POST Body-Based Request

When a route omits `fetchFromModule`, the module accepts a JSON body (extra Pyth Pro fields such as `formats` / `properties` are ignored):

```json
{
  "priceFeedIds": [1, 2],
  "channel": "real_time"
}
```

Use `priceFeedSymbols` instead of `priceFeedIds` when requesting by symbol. `channel` is optional and falls back to the route’s `channel`.

The response matches Pyth Pro’s `{ parsed: { timestampUs, priceFeeds } }` envelope. Missing optional feed fields are emitted as `null`. Unlike the path surface, this surface is all-or-fail: if any requested feed never produces a price, the whole request errors.


## Notes

- Numeric request tokens are treated as feed IDs and must be a u32; non-numeric tokens are resolved to IDs via the Pyth metadata service (concurrently per request) and cached in-process until the feed idles out on every channel.
- Pyth Lazer docs: https://docs.pyth.network/lazer
