FROM oven/bun:1.3.13-alpine AS builder

WORKDIR /build

COPY . .

RUN bun install --frozen-lockfile

RUN bun build --production --sourcemap=inline ./workspace/data-proxy/src/index.ts --outfile dataproxy.mjs --target=bun

RUN ls -la /build

FROM oven/bun:1.3.13-alpine 

WORKDIR /app

COPY --from=builder /build/dataproxy.mjs ./dataproxy.mjs

# Expose the port the app runs on
EXPOSE 5384

CMD ["bun", "run", "dataproxy.mjs", "run"]
