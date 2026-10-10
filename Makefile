SHELL := /bin/bash
.DEFAULT_GOAL := help

PAGES ?=
ES_URL ?= http://localhost:9200
BACKEND_URL ?= http://localhost:3000
INDEX ?= movies

.PHONY: help setup setup-env setup-backend setup-ingestion setup-frontend \
        up down logs wait-es health elastic kibana \
        install install-backend install-ingestion install-frontend \
        ingest ingest-reset sync sync-reset test test-backend build verify \
        backend frontend index-info api-smoke smoke

help: ## List available local development commands
	@awk 'BEGIN {FS = ":.*##"} /^[a-zA-Z0-9_-]+:.*##/ {printf "  %-20s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

setup: ## Create env files, start Elasticsearch, install all dependencies
	$(MAKE) setup-env
	$(MAKE) up
	$(MAKE) wait-es
	$(MAKE) setup-backend
	$(MAKE) setup-ingestion
	$(MAKE) setup-frontend

setup-env: ## Create local env files from examples without overwriting existing files
	@test -f backend/.env || cp backend/.env.example backend/.env
	@test -f ingestion/.env || cp ingestion/.env.example ingestion/.env
	@echo "Environment files ready. Add TMDB_API_KEY to ingestion/.env before ingesting."

setup-backend: ## Install Express backend dependencies
	$(MAKE) setup-env
	$(MAKE) install-backend

setup-ingestion: ## Install TMDB ingestion dependencies
	$(MAKE) setup-env
	$(MAKE) install-ingestion

setup-frontend: ## Install Vue/Vite frontend dependencies
	$(MAKE) install-frontend

up: ## Start Elasticsearch and Kibana
	docker compose up -d

down: ## Stop containers without deleting the Elasticsearch data volume
	docker compose down

logs: ## Follow Elasticsearch and Kibana logs
	docker compose logs -f

wait-es: ## Wait until Elasticsearch responds
	@echo "Waiting for Elasticsearch at $(ES_URL)..."
	@for attempt in $$(seq 1 60); do \
		if curl --silent --fail "$(ES_URL)/_cluster/health" >/dev/null 2>&1; then \
			echo "Elasticsearch is ready."; exit 0; \
		fi; \
		sleep 2; \
	done; \
	echo "Elasticsearch did not become ready within 120 seconds." >&2; exit 1

health: ## Print Elasticsearch cluster health
	curl --silent --show-error --fail "$(ES_URL)/_cluster/health"

elastic: ## Open Elasticsearch in the browser (macOS)
	open "$(ES_URL)"

kibana: ## Open Kibana in the browser (macOS)
	open http://localhost:5601

install: install-backend install-ingestion install-frontend ## Install all Node.js dependencies

install-backend: ## Install Express backend dependencies
	cd backend && npm install

install-ingestion: ## Install ingestion dependencies
	cd ingestion && npm install

install-frontend: ## Install Vue/Vite frontend dependencies
	cd frontend && npm install

ingest: wait-es ## Ingest or update TMDB movies without deleting the index
	cd ingestion && npm run seed -- $(if $(PAGES),--pages=$(PAGES),)

ingest-reset: wait-es ## Recreate the index and ingest movies (requires CONFIRM_RESET=1)
	@test "$(CONFIRM_RESET)" = "1" || (echo "Destructive: this recreates the configured Elasticsearch index. Run: make ingest-reset CONFIRM_RESET=1 [PAGES=25]" >&2; exit 1)
	cd ingestion && npm run seed -- --reset $(if $(PAGES),--pages=$(PAGES),)

sync: ingest ## Shared alias for ingest

sync-reset: ingest-reset ## Shared alias for ingest-reset

test: test-backend ## Run all configured backend tests

test-backend: ## Run Express API contract tests
	cd backend && npm test

build: ## Build the Vue frontend for production
	cd frontend && npm run build

verify: test build ## Run backend tests and build the frontend

backend: ## Start the Express API
	cd backend && npm start

frontend: ## Start the Vite development server
	cd frontend && npm run dev

index-info: ## Show Elasticsearch metadata for the configured index
	curl --silent --show-error --fail "$(ES_URL)/_cat/indices/$(INDEX)?v"

api-smoke: ## Check health, search, and suggestions (backend must be running)
	@set -e; \
	echo "== Backend health =="; curl --silent --show-error --fail "$(BACKEND_URL)/health"; echo; \
	echo "== Browse search =="; curl --silent --show-error --fail "$(BACKEND_URL)/search?size=5"; echo; \
	echo "== Suggestions =="; curl --silent --show-error --fail "$(BACKEND_URL)/suggest?q=spi"; echo

smoke: api-smoke ## Alias for api-smoke
