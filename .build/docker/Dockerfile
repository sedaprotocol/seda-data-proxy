FROM oven/bun:alpine

WORKDIR /app

COPY . .

RUN bun install

# Expose the port the app runs on
EXPOSE 5384

# Entry script to handle conditional startup
COPY .build/docker/docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

ENTRYPOINT ["sh", "./docker-entrypoint.sh"]
