FROM oven/bun:1.3.13-alpine AS builder

WORKDIR /build

# Dependency layer: only invalidates when manifests / lockfile change (not on src edits).
COPY package.json bun.lock bunfig.toml ./
COPY workspace/data-proxy/package.json workspace/data-proxy/
COPY workspace/data-proxy-sdk/package.json workspace/data-proxy-sdk/

RUN bun install --frozen-lockfile

COPY . .

RUN bun build --production --sourcemap=inline ./workspace/data-proxy/src/index.ts --outfile dataproxy.mjs --target=node

FROM node:24-alpine

WORKDIR /app

COPY --from=builder /build/dataproxy.mjs ./dataproxy.mjs

RUN printf '#!/bin/sh\nexec node /app/dataproxy.mjs "$@"\n' > /usr/local/bin/dataproxy \
    && chmod +x /usr/local/bin/dataproxy

RUN cp /usr/local/bin/dataproxy /app/dataproxy

# Expose the port the app runs on
EXPOSE 5384

ENV NODE_ENV=production

ENTRYPOINT ["dataproxy"]
CMD ["run"]