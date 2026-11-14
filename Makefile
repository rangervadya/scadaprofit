SHELL := /bin/bash
.PHONY: up down config verify check tests logs frontend-build

config:
	docker compose config --quiet

up:
	docker compose up -d --build

down:
	docker compose down

verify:
	npm run lint
	npm run typecheck
	npm run test

check: verify

logs:
	docker compose logs -f --tail=150

frontend-build:
	npm --prefix frontend ci
	npm --prefix frontend run build
