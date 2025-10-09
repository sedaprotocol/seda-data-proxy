# SEDA Data Proxy

Allows Data Providers to expose their (private) APIs on the SEDA network. Only eligible overlay nodes are allowed to access the proxy.

## Set up

Install bun:

```sh
curl -fsSL https://bun.sh/install | bash
```

Install all project dependencies:

```sh
bun install
```

Now you are able to run the Data Proxy CLI:

```sh
bun start --help
```

## Running a node

Run the init command to create a keypair and an example config:

```sh
bun start init
```

This will generate two files:

- `config.json`: Configure where routes are going to and what to inject (ex: headers)
- `data-proxy-private-key.json`: Private key that signs the HTTP response. This key is registered on the SEDA chain (see below). If required you can also use the `SEDA_DATA_PROXY_PRIVATE_KEY` environment variable to expose the private key to the node.

Before running the node, the data proxy needs to be registered on-chain:

```sh
# Basic registration
bun start register <ADMIN_ADDRESS> <FEE_AMOUNT_IN_SEDA>

# With additional options
bun start register <ADMIN_ADDRESS> <FEE_AMOUNT_IN_SEDA> \
  --network <NETWORK> \           # The SEDA network to use (devnet/testnet/mainnet)
  --payout-address <ADDRESS> \    # Optional payout address (defaults to admin address)
  --memo <TEXT> \                # Optional memo to attach to registration
  --private-key-file <PATH>      # Path to private key file (defaults to data-proxy-private-key.json)
```

The registration will output a URL where you can submit your transaction to register the data proxy node.

Now you can run the node:

```sh
# Disables the proofing mechanism so it's easier to debug the proxy
bun start run --disable-proof

# The console will output something similiar:
2024-08-19 13:21:46.624 info: Proxy routes is at http://127.0.0.1:5384/proxy/
```

Now you can access the SWApi through curl, browser, or any other HTTP client:

```sh
curl http://localhost:5384/proxy/planets/1
```

The node will auto sign the response and include two headers: `x-seda-signature` and `x-seda-publickey`, which will be used for verification on the executor node.

## Proxy rules

- Only allowed query params from the request are forwared to the `upstreamUrl`. By default no query parameters are allowed.
- Request headers except `host` are forwared to the `upstreamUrl`
- Request Body is forwared to the `upstreamUrl`.
- By default only the upstream header `content-type` is given back. This can however be configured to include more.
- The full body is given back as a response. This can be reduced with using `jsonPath`.

## Environment Variables

For additional security this project uses https://dotenvx.com/, which allows you to encrypt your `.env` file. See the docs on how to set this up.

By default `seda-data-proxy` will check for a `.env` file in the working directory, but you can specify a different path through the `DOTENV_CONFIG_PATH` environment variable.

By default `seda-data-proxy` will check for a private key file at `$HOME/.dotenvx/data-proxy.keys`, if there are no encrypted secrets in the `.env` file the secrets file does not need to be present. You can specify a different location through the `DOTENV_KEYS_PATH` environment variable.

## Configuration

### Route Group

All proxy routes are grouped under a single path prefix, by default this is "proxy". You can change this by specifying the `routeGroup` attribute in the config.json:

```jsonc
{
  "routeGroup": "custom"
  // Rest of config
}
```

### Base URL

In case you want to have software in front of the data proxy to handle the request (such as another proxy or an API management solution) it's possible that the public URL of the data proxy is different from the URL that the data proxy services. This causes a problem in the tamper proofing mechanism since the data proxy needs to sign the request URL, in order to prove that the overlay node did not change the URL. To prevent this you can specify the `baseURL` option in the config.json:

```jsonc
{
  "routeGroup": "proxy",
  "baseURL": "https://my-public-data-proxy.com"
}
```

> [!IMPORTANT]
> Just the protocol and host should be enough, no trailing slash.  
> Should you do additional path rewriting in the proxy layer you can add that to the `baseURL` option, but this is not recommended.

### Multiple routes

A single data proxy can expose different data sources through a simple mapping in the config.json. The `routes` attribute takes an array of proxy route objects which can each have their own configuration.

The two required attributes are `path` and `upstreamUrl`. These specify how the proxy should be called and how the proxy should call the upstream. By default a route is configured as `GET`, but optionally you can specify which methods the route should support with the `methods` attribute.

```jsonc
{
  "routeGroup": "proxy",
  "routes": [
    {
      "path": "/eth-usd",
      "upstreamUrl": "https://myapi.com/eth-usd"
      // Default method is GET
    },
    {
      "path": "/btc-usd",
      "upstreamUrl": "https://myapi.com/btc-usd",
      // You can set multiple methods for the same route
      "method": ["GET", "HEAD"]
    }
  ]
}
```

> [!IMPORTANT]
> The `OPTIONS` method is reserved and cannot be used for a route.

#### Base URL per route

In addition to specifying the `baseURL` at the root level you can also specify it per `route`. The `baseURL` at the `route` level will take precedence over one at the root level.

```jsonc
{
  "routeGroup": "proxy",
  "baseURL": "https://data-proxy.com",
  "routes": [
    {
      // This route will use the "baseURL" from the root
      "path": "/eth-usd",
      "upstreamUrl": "https://myapi.com/eth-usd"
    },
    {
      // This route will use its own "baseURL"
      "baseURL": "https://btc.data-proxy.com",
      "path": "/btc-usd",
      "upstreamUrl": "https://myapi.com/btc-usd"
    }
  ]
}
```

### Query Parameters

By default no query parameters from the original request are passed through to the upstream. If you want to allow the request to send query parameters you can add them to the config.

```jsonc
{
  "routeGroup": "proxy",
  "routes": [
    {
      "path": "/eth-usd",
      "upstreamUrl": "https://myapi.com/eth-usd",
      "allowedQueryParams": ["format", "date"]
    }
  ]
}
```

### Upstream Request Headers

Should your upstream require certain request headers you can configure those in the `routes` object. All headers specified in the `headers` attribute will be sent to the upstream in addition to headers specified by the original request. The headers from the config take precedence over the headers sent in the request.

```jsonc
{
  "routeGroup": "proxy",
  "routes": [
    {
      "path": "/eth",
      "upstreamUrl": "https://myapi.com/endpoint/eth",
      "headers": {
        "x-api-key": "MY-API-KEY",
        "accept": "application/json"
      }
    }
  ]
}
```

### Environment Variable Injection

Sometimes you don't want to expose your API key in a config file, or you have multiple environments running. The Data Proxy node has support for injecting environment variables through the `{$MY_ENV_VARIABLE}` syntax:

```jsonc
{
  "routeGroup": "proxy",
  "routes": [
    {
      "path": "/odds",
      "upstreamUrl": "https://swapi.dev/api/my-odds",
      "headers": {
        "x-api-key": "{$SECRET_API_KEY}"
      }
    }
  ]
}
```

> [!WARNING]
> Environment variables are evaluated during startup of the data proxy. If it detects variables in the config which aren't present in the environment the process will exit with an error message detailing which environment variable it was unable to find.

### Path Parameters

The `routes` objects have support for path parameter variables and forwarding those to the upstream. Simply declare a variable in your path with the `:varName:` syntax and reference them in the upstreamUrl with the `{:varName:}` syntax. See below for an example:

```jsonc
{
  "routeGroup": "proxy",
  "routes": [
    {
      "path": "/:coinA/:coinB",
      // Use {} to inject route variables
      "upstreamUrl": "https://myapi.com/{:coinA}-{:coinB}"
    }
  ]
}
```

### Forwarding Response Headers

By default the data proxy node will only forward the `content-type` header from the upstream response. If required you can specify which other headers the proxy should forward to the requesting client:

```jsonc
{
  "routeGroup": "proxy",
  "routes": [
    {
      "path": "/planets/:planet",
      "upstreamUrl": "https://swapi.dev/api/planets/{:planet}",
      // Now the API will also return the server header from SWApi
      "forwardResponseHeaders": ["content-type", "server"],
      "headers": {
        "x-api-key": "some-api-key"
      }
    }
  ]
}
```

### Wildcard Routes

The Data Proxy node has support for wildcard routes, which allows you to quickly expose all your APIs:

```jsonc
{
  "routeGroup": "proxy",
  "routes": [
    {
      // The whole path will be injected in the URL
      "path": "/*",
      "upstreamUrl": "https://swapi.dev/api/{*}",
      "headers": {
        "x-api-key": "some-api-key"
      }
    }
  ]
}
```

### JSON Path

If you don't want to expose all API info you can use `jsonPath` to return a subset of the response:

```jsonc
{
  "routeGroup": "proxy",
  "routes": [
    {
      "path": "/planets/:planet",
      "upstreamUrl": "https://swapi.dev/api/planets/{:planet}",
      // Calling the API http://localhost:5384/proxy/planets/1 will only return "Tatooine" and omit the rest
      "jsonPath": "$.name",
      "headers": {
        "x-api-key": "some-api-key"
      }
    }
  ]
}
```

### Status Endpoint

The Data Proxy node has support for exposing status information through some endpoints. This can be used to monitor the health of the node and the number of requests it has processed.

The status endpoint has two routes:

- `/status/health`  
  Returns a JSON object with the following strucuture:
  ```jsonc
  {
    "status": "healthy",
    "metrics": {
      "uptime": "P0Y0M1DT2H3M4S", // ISO 8601 duration since the node was started
      "requests": 1024, // Number of requests processed
      "errors": 13 // Number of errors that occurred
    }
  }
  ```
- `/status/pubkey`  
  Returns the public key of the node.
  ```jsonc
  {
    "pubkey": "031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f"
  }
  ```

#### Status Configuration

The status endpoints can be configured in the config file under the statusEndpoints attribute:

```jsonc
{
  // Other config...
  "statusEndpoints": {
    "root": "status",
    // Optional
    "apiKey": {
      "header": "x-api-key",
      "secret": "some-secret"
    }
  }
}
```

- `root`: Root path for the status endpoints. Defaults to `status`.
- `apiKey`: Optionally secure the status endpoints with an API key. The `header` attribute is the header key that needs to be set, and `secret` is the value that it needs to be set to.  
  The `statusEndpoints.apiKey.secret` attribute supports the `{$MY_ENV_VARIABLE}` syntax for injecting a value from the environment during start up.


### Environment

The following environment variables are available for configuration:


| Environment variable | Description | Default |
| --- | --- | --- |
| `SERVER_PORT` | Port the HTTP server listens on. | `5384` |
| `LOG_LEVEL` | Console log level. | `info` |
| `LOG_FILE_DIR` | Directory for rotating log files. When set, file logging is enabled. | `./logs/` |
| `LOG_FILE_LOG_LEVEL` | Log level for file transport. | `debug` |
| `LOG_FILE_MAX_FILES` | How many log files to keep (time or count), per winston-daily-rotate-file. | `14d` |
| `LOG_FILE_DATE_PATTERN` | Date pattern used in rotated log filenames. | `YYYY-MM-DD` |

## Deployment

The SEDA Data Proxy can be deployed in several ways:

- [Local Installation](#set-up) (shown above)
- [Docker Deployment](#docker-deployment)
- [Kubernetes Deployment](#kubernetes-deployment)

### Docker Deployment

Pull the latest image:

```bash
docker pull ghcr.io/sedaprotocol/seda-data-proxy:v0.0.3
```

Initialize configuration and keys (choose one option):

```bash
# Option A: Save files to local directory
docker run \
  -v $PWD/config:/app/config \
  ghcr.io/sedaprotocol/seda-data-proxy:v0.0.3 \
  init -c ./config/config.json -pkf config/data-proxy-private-key.json

# Option B: Print to console for manual setup
docker run ghcr.io/sedaprotocol/seda-data-proxy:v0.0.3 init --print
```

Register your node:

```bash
# Option A: Using private key file
docker run \
  -v $PWD/config/data-proxy-private-key.json:/app/data-proxy-private-key.json \
  ghcr.io/sedaprotocol/seda-data-proxy:v0.0.3 \
  register <seda-address> <seda-amount>

# Option B: Using environment variable
docker run \
  --env SEDA_DATA_PROXY_PRIVATE_KEY=$SEDA_DATA_PROXY_PRIVATE_KEY \
  ghcr.io/sedaprotocol/seda-data-proxy:v0.0.3 \
  register <seda-address> <seda-amount>
```

Run the proxy:

```bash
# Option A: Using private key file
docker run -d \
  --name seda-data-proxy \
  -p 5384:5384 \
  -v $PWD/config/config.json:/app/config.json \
  -v $PWD/config/data-proxy-private-key.json:/app/data-proxy-private-key.json \
  ghcr.io/sedaprotocol/seda-data-proxy:v0.0.3 \
  run --disable-proof

# Option B: Using environment variable
docker run -d \
  --name seda-data-proxy \
  -p 5384:5384 \
  -v $PWD/config/config.json:/app/config.json \
  --env SEDA_DATA_PROXY_PRIVATE_KEY=$SEDA_DATA_PROXY_PRIVATE_KEY \
  ghcr.io/sedaprotocol/seda-data-proxy:v0.0.3 \
  run --disable-proof
```

> [!NOTE]
> The config.json file must always be mounted as a volume.

> [!IMPORTANT]
> Remove `--disable-proof` in production environments

### Kubernetes Deployment

For production deployments on Kubernetes, we provide a Helm chart in the `helm/` directory. Here's a basic setup:

Basic Helm configuration example:

```yaml
# values.yaml

# ... other configuration ...

secret:
  sedaDataProxyPrivateKey: "" # Will be set via CLI

# Remove this flag in production - it disables request verification
sedaProxyFlags: "--disable-proof"

sedaProxyConfig:
  routes:
    - path: "/*"
      upstreamUrl: "https://swapi.dev/api/"
      methods:
        - GET
```

Deploy using Helm from the project root:

```bash
helm install my-proxy ./helm --set secret.sedaDataProxyPrivateKey=$SEDA_DATA_PROXY_PRIVATE_KEY
```

> [!NOTE]  
> The above is a minimal example. Your specific deployment may require additional configuration for services, ingress, resources, and security settings based on your infrastructure requirements. Please consult with your infrastructure team for production deployments.
