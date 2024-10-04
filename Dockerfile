FROM oven/bun:alpine

WORKDIR /app

COPY . .

RUN bun install

# Expose the port the app runs on
EXPOSE 5384


# Entry script to handle conditional startup
COPY ./docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

# Run init to generate the config.json and private key file
RUN bun start init

ENTRYPOINT ["sh", "./docker-entrypoint.sh"]

