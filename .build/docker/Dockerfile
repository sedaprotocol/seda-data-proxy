FROM oven/bun:alpine

WORKDIR /app

COPY . .

RUN echo 'export PS1="\e[01;32m\u\e[m:\e[01;34m\w\e[m\$ "' >> /home/bun/.bashrc

RUN bun install

RUN bun build --compile --minify --sourcemap ./workspace/data-proxy/src/index.ts --outfile dataproxy --target=bun-linux-arm64

# Expose the port the app runs on
EXPOSE 5384

RUN chmod +x dataproxy

COPY .build/docker/docker-entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

ENTRYPOINT ["sh", "/app/entrypoint.sh"]
