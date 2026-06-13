.PHONY: up build down clean logs client-build nakama-build test

up:
	docker compose up

build:
	docker compose build

down:
	docker compose down

clean:
	docker compose down -v

logs:
	docker compose logs -f

client-build:
	cd client && npm ci && npm run build

nakama-build:
	cd nakama && npm ci && npm run build

test:
	cd nakama && npm ci && npm test
