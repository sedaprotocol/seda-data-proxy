# PM Insights module

Proxies requests to the [PM Insights](https://pminsights.com/) API. On startup the module logs in, caches a bearer token, and refreshes it on a schedule. Each proxied request calls the upstream path from `fetchFromModule` with the bearer token and returns the upstream response as-is (status, body, and content type).

## Environment variables

Set the env vars named by `emailEnvKey` and `passwordEnvKey` in the module config (defaults in the example below):

| Variable | Purpose |
| --- | --- |
| `PM_INSIGHTS_EMAIL` | Account email (sent as `username` to `/login`) |
| `PM_INSIGHTS_PASSWORD` | Account password |

Both are required; config parsing fails if either is unset. Values are treated as secrets and redacted from logs.

## Module config

```jsonc
{
  "modules": [
    {
      "type": "pm-insights",
      "name": "pminsights",
      "baseUrl": "https://api.pminsights.com/", // optional, this is the default
      "emailEnvKey": "PM_INSIGHTS_EMAIL",
      "passwordEnvKey": "PM_INSIGHTS_PASSWORD",
      "tokenRefreshIntervalMinutes": 50, // optional, default 50
      "tokenRetryIntervalMinutes": 5 // optional, default 5
    }
  ]
}
```

| Field | Required | Default | Description |
| --- | --- | --- | --- |
| `name` | yes | — | Module id referenced by routes via `moduleName` |
| `type` | yes | — | Must be `"pm-insights"` |
| `baseUrl` | no | `https://api.pminsights.com/` | PM Insights API base URL |
| `emailEnvKey` | yes | — | Env var name for the login email |
| `passwordEnvKey` | yes | — | Env var name for the login password |
| `tokenRefreshIntervalMinutes` | no | `50` | How often to call `POST /login` to refresh the bearer token (min 1) |
| `tokenRetryIntervalMinutes` | no | `5` | Retry interval when a refresh login fails (min 1) |

## Route config

```jsonc
{
  "routes": [
    {
      "type": "pm-insights",
      "moduleName": "pminsights",
      "path": "/:symbol",
      "fetchFromModule": "issuer/{:symbol}",
      "method": ["GET"]
    },
		{
			"type": "pm-insights",
			"moduleName": "pminsights",
			"path": "/constituents/:sector",
			"fetchFromModule": "feed/sectors/constituents/{:sector}",
			"method": ["GET"]
		}
  ]
}
```

| Field | Description |
| --- | --- |
| `type` | Must be `"pm-insights"` |
| `moduleName` | Must match a configured PM Insights module `name` |
| `path` | Proxy path; use path params as needed |
| `fetchFromModule` | Upstream path template relative to `baseUrl` (e.g. `issuer/{:symbol}`); substituted from path params. Request query string is forwarded. |
| `method` | Allowed HTTP methods (typically `["GET"]`) |

Example request after starting the proxy:

```bash
curl "http://127.0.0.1:5384/proxy/AVAN08"
```
