SHELL := /bin/bash
.PHONY: up down config check tests logs frontend-build

config:
	docker compose config --quiet

up:
	docker compose up -d --build

down:
	docker compose down

check:
	npm --prefix backend run check
	PYTHONPATH=backend python -m unittest discover -s tests/vdgo -p 'test_*.py' -v

logs:
	docker compose logs -f --tail=150

frontend-build:
	npm --prefix frontend ci
	npm --prefix frontend run build
