.PHONY: up down logs health elastic kibana \
        install install-backend install-ingestion install-frontend \
        test test-backend \
        ingest ingest-reset \
        backend frontend \
        setup

up:
	docker compose up -d

down:
	docker compose down

logs:
	docker compose logs -f

health:
	curl -s http://localhost:9200 | jq

elastic:
	open http://localhost:9200

kibana:
	open http://localhost:5601

install: install-backend install-ingestion install-frontend

install-backend:
	cd backend && npm install

install-ingestion:
	cd ingestion && npm install

install-frontend:
	cd frontend && npm install

test: test-backend

test-backend:
	cd backend && npm test

ingest:
	cd ingestion && npm run seed

ingest-reset:
	cd ingestion && npm run seed -- --reset

backend:
	cd backend && npm start

frontend:
	cd frontend && npm run dev

setup:
	docker compose up -d
	$(MAKE) install
