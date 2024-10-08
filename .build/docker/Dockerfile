FROM oven/bun:alpine

ARG TARGET_ARCH

WORKDIR /app

COPY . .

RUN bun install --frozen-lockfile

RUN bun build --compile --minify --sourcemap ./workspace/data-proxy/src/index.ts --outfile dataproxy --target=${TARGET_ARCH}

# Data Proxy RPC port
EXPOSE 5384

RUN chmod +x dataproxy

ENTRYPOINT ["./dataproxy"]
CMD ["run"]
