# Developer shortcuts. Run `make help` for the list.
#
# Override the interpreter to reuse an existing virtualenv:  make test PY=/path/to/venv/bin/python

PYTHON ?= python3
VENV   ?= backend/.venv
PY     ?= $(VENV)/bin/python
MANAGE  = cd backend && $(abspath $(PY)) manage.py

# Font families `make content` installs: the N most popular of the curated list (253 in all).
FONT_FAMILIES ?= 100

# Optional first administrator for `make seed`: make seed ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=...
ADMIN_EMAIL    ?= admin@doory.local
ADMIN_PASSWORD ?=
export ADMIN_EMAIL ADMIN_PASSWORD

.DEFAULT_GOAL := help
.PHONY: help setup dev-api dev-web test test-api test-web lint docs-check fmt seed content migrate docker-up docker-down

help: ## List the available targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-12s %s\n", $$1, $$2}'

setup: ## Install backend and frontend dependencies and prepare the local database
	test -x $(PY) || $(PYTHON) -m venv $(VENV)
	$(PY) -m pip install --upgrade pip
	$(PY) -m pip install -r backend/requirements-dev.txt
	test -f backend/.env || cp backend/.env.example backend/.env
	$(MANAGE) migrate --noinput
	cd frontend && npm ci

dev-api: ## Run the Django API on http://localhost:8000
	$(MANAGE) runserver 8000

dev-web: ## Run the Vite dev server on http://localhost:5173 (proxies /api to the API)
	cd frontend && npm run dev

migrate: ## Apply database migrations
	$(MANAGE) migrate --noinput

test: test-api test-web ## Run the backend and frontend test suites

test-api: ## Backend tests (pytest)
	cd backend && $(abspath $(PY)) -m pytest

test-web: ## Frontend tests (vitest)
	cd frontend && npm test

lint: docs-check ## Ruff, TypeScript, ESLint and docs checks (no changes)
	cd backend && $(abspath $(PY)) -m ruff check . && $(abspath $(PY)) -m ruff format --check .
	cd frontend && npm run lint && npm run typecheck

docs-check: ## Check that every setting is documented in docs/self-hosting/configuration.md
	sh docs/check-settings.sh

fmt: ## Auto-fix and format the backend code
	cd backend && $(abspath $(PY)) -m ruff check --fix . && $(abspath $(PY)) -m ruff format .

# The downloads are independent and every command can simply be run again, so one failing source
# (make prints "Error 1 (ignored)") does not stop the others.
content: migrate ## Install first-run content: template categories and starter templates, elements, fonts, model, audio library (network, minutes)
	$(MANAGE) seed_gallery
	$(MANAGE) seed_templates
	$(MANAGE) seed_elements
	-$(MANAGE) sync_element_packs
	-$(MANAGE) sync_fonts --popular $(FONT_FAMILIES)
	-$(MANAGE) sync_models
	$(MANAGE) sync_audio

seed: export DJANGO_SUPERUSER_EMAIL = $(ADMIN_EMAIL)
seed: export DJANGO_SUPERUSER_PASSWORD = $(ADMIN_PASSWORD)
seed: content ## Prepare a fresh dev database: the first-run content and, with ADMIN_PASSWORD, an admin account
	@if [ -z "$$ADMIN_PASSWORD" ]; then echo "Pass ADMIN_PASSWORD=... to create an admin account ($$ADMIN_EMAIL)."; \
	else out=$$($(MANAGE) createsuperuser --noinput 2>&1) \
	  && echo "Admin account created: $$ADMIN_EMAIL" || echo "$$out"; fi

docker-up: ## Build and start the full stack (requires a .env file, see .env.example)
	@test -f .env || { echo "Create .env first: cp .env.example .env"; exit 1; }
	docker compose up --build --detach
	@echo "Doory is starting on http://localhost:$${WEB_PORT:-8080}"

docker-down: ## Stop the Docker stack (data volumes are kept)
	docker compose down
