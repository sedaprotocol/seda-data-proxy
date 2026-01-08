FROM oven/bun:1.3.5-alpine

ARG TARGET_ARCH

WORKDIR /app

COPY . .

RUN bun install --frozen-lockfile

RUN bun build --compile --minify --sourcemap ./workspace/data-proxy/src/index.ts --outfile dataproxy --target=${TARGET_ARCH}

# Expose the port the app runs on
EXPOSE 5384

RUN chmod +x dataproxy

ENTRYPOINT ["./dataproxy"]
CMD ["run"]
