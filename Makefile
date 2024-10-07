.PHONY: build run stop up clean logs ssh

# Define the docker-compose file location
DOCKER_COMPOSE_FILE := .build/docker/docker-compose.yml

# Build the Docker image
build:
	docker compose -f $(DOCKER_COMPOSE_FILE) build

# Run the Docker container
run:
	docker compose -f $(DOCKER_COMPOSE_FILE) up

# Stop the Docker container
stop:
	docker compose -f $(DOCKER_COMPOSE_FILE) down

# Build and run the Docker container
up: build run

# Clean up Docker resources
clean:
	docker compose -f $(DOCKER_COMPOSE_FILE) down --rmi all --volumes --remove-orphans

# Show logs
logs:
	docker compose -f $(DOCKER_COMPOSE_FILE) logs -f

# SSH into the running container
ssh:
	docker compose -f $(DOCKER_COMPOSE_FILE) exec seda-data-proxy sh
