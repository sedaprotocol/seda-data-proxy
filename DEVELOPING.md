# Developing

## Effect & WebSocket ingest

Turns out that Effect is too expensive for the inbound message processing path, so we've removed most of Effect from that path. We've kept it for handling errors and logging for 'uncommon' events like errors and subscription confirmations. This is a balance between performance and operational simplicity.

## Multi-venue performance benchmark

The performance bench starts mock WSS venue backends on the host, builds the production Docker image (bundled Node, same as deploy), points the container at those mocks, and drives `POST /proxy/multi`.

### Prerequisites

- [Bun](https://bun.sh)
- Docker (daemon running)

### Run

```sh
bun install
bun run bench:performance
```

The first run builds `seda-data-proxy:performance-bench` from `.build/docker/Dockerfile`. Later runs:

```sh
# Reuse the image from the last build
bun run bench:performance -- --skip-build

# Smoke test (1s warmup, 2s load)
bun run bench:performance -- --quick --skip-build
```

Flags after `--` are passed to the bench script.

### Useful flags

```sh
# Stress ingest
bun run bench:performance -- --binance-hz 1000 --duration 10

# Subset of venues
bun run bench:performance -- --venues binance,lighter

# Tail proxy container logs
bun run bench:performance -- --verbose
```

| Flag | Default | Notes |
| --- | --- | --- |
| `--quick` | off | 1s warmup, 2s load (otherwise 2s / 5s) |
| `--skip-build` | off | Reuse `seda-data-proxy:performance-bench` if it exists |
| `--image <name>` | `seda-data-proxy:performance-bench` | Use an existing image instead |
| `--verbose` | off | Follow container logs |
| `--venues <list>` | all | Comma-separated: `binance`, `lighter`, `dxfeed`, `pyth`, `hydromancer` |
| `--duration <s>` | 5 (2 with `--quick`) | Timed HTTP load window |
| `--warmup <s>` | 2 (1 with `--quick`) | Wait for priced responses before measuring |
| `--http-rps <n>` | 30 | Multi-endpoint requests per second |
| `--binance-hz` / `--binance-symbols` | 25 / 40 | |
| `--lighter-hz` / `--lighter-markets` | 10 / 20 | |
| `--dxfeed-hz` / `--dxfeed-symbols` | 30 / 30 | |
| `--pyth-hz` / `--pyth-feeds` | 5 / 50 | Envelope rate, not per-feed ticks |
| `--hydro-hz` / `--hydro-coins` | 1 / 30 | |

### Reading results

Compare **HTTP latency, error rate, and missing `__sedaHasPrice`** across code changes. `container CPU` is `docker stats` as a share of host CPUs, so it is not event-loop utilisation and is not comparable across machines with different core counts.

Raise `--binance-hz` (and the other `--*-hz` flags) to stress ingest; raise `--http-rps` to stress the multi-endpoint HTTP path.
