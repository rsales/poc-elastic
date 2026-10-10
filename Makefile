SHELL := /bin/bash
.DEFAULT_GOAL := help

PAGES ?= 5
BACKEND_URL ?= http://localhost:3000
ES_URL ?= http://localhost:9200

.PHONY: help setup setup-env install install-backend install-ingestion install-frontend \
        up down status logs wait-es reindex ingest test build verify smoke \
        backend-dev frontend-dev

help: ## List available commands
	@awk 'BEGIN {FS = ":.*##"} /^[a-zA-Z0-9_-]+:.*##/ {printf "  %-20s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

setup: setup-env install ## Prepare local .env files and install dependencies

setup-env: ## Create local .env files from examples without overwriting existing files
	@test -f ingestion/.env || cp ingestion/.env.example ingestion/.env
	@test -f backend/.env || cp backend/.env.example backend/.env
	@echo "Local env files are ready. Add TMDB_API_KEY to ingestion/.env."

install: install-backend install-ingestion install-frontend ## Install dependencies for all applications

install-backend: ## Install backend dependencies
	cd backend && npm install

install-ingestion: ## Install ingestion dependencies
	cd ingestion && npm install

install-frontend: ## Install frontend dependencies
	cd frontend && npm install

up: ## Start Elasticsearch and Kibana
	docker compose up -d

down: ## Stop Elasticsearch and Kibana (keeps the data volume)
	docker compose down

status: ## Show Docker service status
	docker compose ps

logs: ## Follow Elasticsearch and Kibana logs
	docker compose logs -f elasticsearch kibana

wait-es: ## Wait until Elasticsearch responds
	@echo "Waiting for Elasticsearch at $(ES_URL)..."
	@for attempt in $$(seq 1 60); do \
		if curl --silent --show-error --fail "$(ES_URL)/_cluster/health" >/dev/null 2>&1; then \
			echo "Elasticsearch is ready."; exit 0; \
		fi; \
		sleep 2; \
	done; \
	echo "Elasticsearch did not become ready within 120 seconds." >&2; exit 1

reindex: wait-es ## Recreate the index and ingest data (destructive; requires CONFIRM_RESET=1)
	@test "$(CONFIRM_RESET)" = "1" || (echo "This deletes and recreates the '$(or $(INDEX),movies)' index. Run: make reindex CONFIRM_RESET=1 PAGES=$(PAGES)" >&2; exit 1)
	cd ingestion && npm run seed -- --reset --pages=$(PAGES)

ingest: wait-es ## Ingest/update movies without deleting the index (index must already exist)
	cd ingestion && npm run seed -- --pages=$(PAGES)

test: ## Run backend contract tests
	cd backend && npm test

build: ## Build the Vue frontend for production
	cd frontend && npm run build

verify: test build ## Run local tests and build checks

smoke: ## Check backend health, search, and suggestions (backend must be running)
	@set -e; \
	echo "== Health =="; curl --silent --show-error --fail "$(BACKEND_URL)/health"; echo; \
	echo "== Search =="; curl --silent --show-error --fail "$(BACKEND_URL)/search?size=5"; echo; \
	echo "== Suggestions =="; curl --silent --show-error --fail "$(BACKEND_URL)/suggest?q=spi"; echo

backend-dev: ## Run the backend in watch mode (foreground)
	cd backend && npm run dev

frontend-dev: ## Run the frontend dev server (foreground)
	cd frontend && npm run dev
