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

- Request query params are forwared to the `upstreamUrl`
- Request headers except `host` are forwared to the `upstreamUrl`
- Request Body is forwared to the `upstreamUrl`
- By default only the upstream header `content-type` is given back. This can however be configured to include more.
- The full body is given back as a response. This can be reduced with using `jsonPath`

## Configuration

The config file allows you to configure multiple routes:

```jsonc
{
  "routeGroup": "proxy",
  "routes": [
    {
      "path": "/eth-usd",
      "upstreamUrl": "https://myapi.com/eth-usd",
      // Default is GET
      "headers": {
        "x-api-key": "some-api-key"
      }
    },
    {
      "path": "/btc-usd",
      "upstreamUrl": "https://myapi.com/btc-usd",
      // Allows for multiple method setting
      "method": ["GET", "HEAD"],
      "headers": {
        "x-api-key": "some-api-key"
      }
    }
  ]
}
```

### Variables

The config.json has support for using variable routes by using `:varName`:

```jsonc
{
  "routeGroup": "proxy",
  "routes": [
    {
      "path": "/:coinA/:coinB",
      // Use {} to inject route variables
      "upstreamUrl": "https://myapi.com/{:coinA}-{:coinB}",
      "headers": {
        "x-api-key": "some-api-key",
        // Can also be injected in the header
        "x-custom": "{:coinA}"
      }
    }
  ]
}
```

### JSON Path

If you don't want to expose all API info you can use `jsonPath` to reduce the response:

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

### Forwarding headers

By default the data proxy node will only forward the `content-type` as a response. This can be configured to include more headers if desired:

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

### Environment variables injection

Sometimes you don't want to expose your API key in a config file, or you have multiple environments running. The Data Proxy node has support for injecting environment variables through `{$MY_ENV_VARIABLE}`:

```jsonc
{
  "routeGroup": "proxy",
  "routes": [
    {
      // Everything will be injected in the URL
      "path": "/*",
      "upstreamUrl": "https://swapi.dev/api/{*}",
      "headers": {
        "x-api-key": "{$SECRET_API_KEY}"
      }
    }
  ]
}
```

### Wildcard routes

The Data Proxy node has support for wildcard routes, which allows you to quickly expose all your APIs:

```jsonc
{
  "routeGroup": "proxy",
  "routes": [
    {
      // Everything will be injected in the URL
      "path": "/*",
      "upstreamUrl": "https://swapi.dev/api/{*}",
      "headers": {
        "x-api-key": "some-api-key"
      }
    }
  ]
}
```

## Status endpoints

The Data Proxy node has support for exposing status information through some endpoints. This can be used to monitor the health of the node and the number of requests it has processed.

The status endpoint has two routes:

- `/<statusEndpointsRoot>/health`  
  Returns a JSON object with the following structure:

  ```json
  {
    "status": "healthy",
    "metrics": {
      "uptime": "P0Y0M1DT2H3M4S", // ISO 8601 duration since the node was started
      "requests": 1024, // Number of requests processed
      "errors": 13 // Number of errors that occurred
    }
  }
  ```

- `/<statusEndpointsRoot>/pubkey`  
  Returns the public key of the node.
  ```json
  {
    "pubkey": "031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f"
  }
  ```

### Configuration

The status endpoints can be configured in the config file:

```json
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
  sedaDataProxyPrivateKey: ""  # Will be set via CLI

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