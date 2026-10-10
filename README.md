# Elasticsearch POC

A full-stack movie-search proof of concept using **Elasticsearch 8**, a **Node.js/Express API**, and a **Vue 3 + Vite frontend**. Movie metadata is sourced from TMDB.

This repository is the Node implementation of the search experiments being compared with [ror-elastic](https://github.com/rsales/ror-elastic). Both POCs share behavior scenarios under `contracts/search-cases.json`; implementation-specific response envelopes remain compatible with their existing frontends.

## Capabilities

- TMDB ingestion with Elasticsearch bulk indexing
- English text analysis, stemming and accent folding
- Full-text search, field boosts and phrase ranking
- Quoted phrases, required/excluded terms, wildcard and fuzzy query syntax
- Completion-based autocomplete
- Genre and minimum-rating filters
- Genre and five-year histogram facets
- Highlighting, pagination and deterministic ordering
- API parameter validation and normalized errors
- Shared search-contract fixtures

## Architecture

The Vue frontend calls Express over HTTP. The API translates request parameters into Elasticsearch Query DSL. The separate ingestion script fetches TMDB movie metadata and bulk-indexes it into the `movies` index.

```text
                    ┌─────────────────┐
                    │   Vue 3 + Vite  │
                    │    Frontend     │
                    └────────┬────────┘
                             │ HTTP (/api → Vite proxy → Express)
                             ▼
                    ┌─────────────────┐
                    │   Express API   │
                    │    Backend      │
                    └────────┬────────┘
                             │ Elasticsearch Query DSL
                             ▼
                    ┌─────────────────┐
                    │ Elasticsearch   │
                    │  movies index   │
                    └────────▲────────┘
                             │ bulk indexing
                    ┌────────┴────────┐
                    │    Ingestion    │
                    │  Node.js + TMDB │
                    └────────▲────────┘
                             │ HTTP API
                             ▼
                    ┌─────────────────┐
                    │     TMDB API    │
                    └─────────────────┘
```

## Prerequisites

- Docker and Docker Compose
- Node.js 18+ and npm
- A TMDB v3 API key or v4 Read Access Token
- `curl`; `jq` is optional for formatted terminal output

Elasticsearch is configured for a local single-node POC with security disabled. Do not expose this stack to a public network or use it as a production deployment.

## Quick start

Run all commands from the repository root.

### 1. Configure environment variables

Create local environment files from the examples:

```bash
make setup-env
```

The command creates `backend/.env` and `ingestion/.env` only when they do not already exist. Add your TMDB API key or v4 Read Access Token to `ingestion/.env`. Do not commit local `.env` files or credentials.

### 2. Start services and install dependencies

```bash
make setup
```

This creates any missing environment files, starts Elasticsearch and Kibana, waits for Elasticsearch, and installs backend, ingestion and frontend dependencies. It does not ingest movies automatically.

| Service | URL |
| --- | --- |
| Elasticsearch | http://localhost:9200 |
| Kibana | http://localhost:5601 |
| Express API | http://localhost:3000 |
| Vue/Vite frontend | http://localhost:5173 |

Check Elasticsearch:

```bash
make health
```

### 3. Ingest movie data

For a fresh index, recreate the index and then ingest the default page count configured in `ingestion/.env` (currently 5 pages, up to about 100 records):

```bash
make ingest-reset CONFIRM_RESET=1
```

**Warning:** `ingest-reset` deletes and recreates the configured Elasticsearch index before ingestion. Use it only when replacing the existing index contents is acceptable.

To ingest or update data without deleting the index:

```bash
make ingest
```

Both modes use the TMDB ID as Elasticsearch `_id`; repeated movie IDs update the same document. Set the page count in `ingestion/.env` or override it for a command:

```bash
make ingest PAGES=25
make ingest-reset CONFIRM_RESET=1 PAGES=25
```

### 4. Prepare, test, and run the apps

Install only one part of the project when needed:

```bash
make setup-backend
make setup-ingestion
make setup-frontend
```

Run backend tests and build the frontend:

```bash
make test
make build
# Or both:
make verify
```

Start the Express API and frontend in **separate terminals**:

```bash
make backend
```

```bash
make frontend
```

Open http://localhost:5173. The Vite dev server proxies `/api/*` requests to Express at port 3000. Use `Ctrl+C` to stop each foreground process.

## Makefile commands

Run `make help` to list targets. The command names intentionally match the Rails POC where their purposes overlap.

| Command | Description |
| --- | --- |
| `make setup` | Create env files, start infrastructure, wait for Elasticsearch and install dependencies |
| `make setup-env` | Create local env files without overwriting existing files |
| `make setup-backend` | Configure env and install Express dependencies |
| `make setup-ingestion` | Configure env and install TMDB ingestion dependencies |
| `make setup-frontend` | Install Vue/Vite dependencies |
| `make up` / `make down` | Start/stop Elasticsearch and Kibana; data volume is preserved |
| `make wait-es` / `make health` | Wait for Elasticsearch / display cluster health |
| `make install` | Install all Node.js dependencies |
| `make ingest PAGES=25` | Ingest/update TMDB movies without resetting the index |
| `make ingest-reset CONFIRM_RESET=1 PAGES=25` | Recreate the index and ingest data |
| `make sync PAGES=25` / `make sync-reset CONFIRM_RESET=1 PAGES=25` | Rails-compatible aliases for ingest commands |
| `make test` | Run backend tests |
| `make build` / `make verify` | Build frontend / run tests and build |
| `make backend` / `make frontend` | Start Express / Vite |
| `make index-info` | Inspect the configured Elasticsearch index |
| `make api-smoke` | Check health, browse search and suggestions |

`ES_URL`, `BACKEND_URL`, and `INDEX` can override the defaults for the local helper commands.

## Ingestion and index mapping

The `ingestion/seed.js` script fetches TMDB genre metadata and popular-movie pages, maps genre IDs to names, prepares documents, bulk-indexes them, refreshes the index, and reports successful operations separately from the final document count. Failed bulk items are logged with document IDs and reasons; any indexing failure results in a non-zero exit status.

Indexed fields include `tmdb_id`, `title`, `original_title`, `short_description`, `overview`, `content`, `genres`, `year`, `release_date`, `original_language`, `popularity`, `vote_average`, `poster_url`, `poster_path`, and `backdrop_path`.

The mapping is defined in `mappings/movies.json`. To inspect it or test the analyzer, open Kibana Dev Tools at [http://localhost:5601/app/dev_tools#/console](http://localhost:5601/app/dev_tools#/console):

```http
GET /movies/_mapping

POST /movies/_analyze
{
  "analyzer": "english_analyzer",
  "text": "The Red Cars are running fast on the highway"
}
```

Mapping changes require recreating and repopulating the index with the guarded `make ingest-reset CONFIRM_RESET=1` command.

## Search API contract

The Express API listens on port 3000. Its environment variables are `PORT`, `ES_URL`, and `INDEX`, with defaults `3000`, `http://localhost:9200`, and `movies`.

### Health

`GET /health` returns HTTP 200 when Elasticsearch is reachable and HTTP 503 when it is not.

```bash
curl -i http://localhost:3000/health
```

### Search

`GET /search`

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `q` | string | empty | Text query; empty query browses all indexed documents |
| `genres` | string | empty | Comma-separated exact genre filters, e.g. `Action,Drama` |
| `minRating` | number | none | Minimum `vote_average`, from 0 to 10 |
| `from` | integer | `0` | Non-negative pagination offset |
| `size` | integer | `20` | Page size from 1 to 50 |

```bash
curl -sG --data-urlencode 'q="Spider-Man" -Homecoming' \
  "http://localhost:3000/search" | jq '{total, titles: [.hits[].title]}'

curl -sG --data-urlencode 'q=space adventure' \
  --data-urlencode 'genres=Science Fiction' \
  --data-urlencode 'minRating=7' \
  "http://localhost:3000/search" | jq
```

The response uses `hits`, `facets`, and `took_ms`; the Rails POC keeps its frontend-compatible `items` envelope. Compare behavior and document IDs rather than forcing both frontends to consume the same response shape or comparing exact Elasticsearch `_score` values.

### Query semantics

- Ordinary terms use `simple_query_string` with default operator `OR` for broad recall.
- A query containing an exclusion (for example `"Spider-Man" -Homecoming`) switches the default operator to `AND`, keeping the positive clause mandatory while excluding matches for the negative term.
- Supported syntax includes quoted phrases, required terms (`+`), exclusions (`-`), wildcard prefixes, fuzzy terms and grouping supported by `simple_query_string`.
- A separate phrase clause boosts ranking; it is not independently mandatory.
- Filters do not directly contribute to relevance scoring.
- Text queries sort by score, then popularity and TMDB ID. Browse mode sorts by popularity and TMDB ID.
- Responses include genre facets, five-year histogram facets, and `<mark>` highlights.

### Suggestions

`GET /suggest?q=spi&size=5` uses the `title.suggest` completion field with fuzzy completion and duplicate skipping. The size must be between 1 and 10.

```bash
curl -s "http://localhost:3000/suggest?q=spi" | jq
```

### Movie lookup and validation

`GET /movies/:id` fetches a movie by TMDB ID (404 when it is not indexed). Invalid scalar parameters, pagination values, ratings or suggestion sizes return HTTP 400. Unexpected failures return a generic HTTP 500.

```bash
curl -i http://localhost:3000/movies/634649
curl -i "http://localhost:3000/search?from=-1"
curl -i "http://localhost:3000/search?size=51"
```

## Shared fixtures and parity checks

The shared behavior scenarios live in `contracts/search-cases.json` and are intended for both `poc-elastic` and `ror-elastic`. The scenarios cover plain queries, phrases, required and excluded terms, wildcard/fuzzy queries, filters, browsing, suggestions and accent folding.

Run local checks with:

```bash
make verify
make api-smoke
```

`api-smoke` requires the backend to be running; meaningful result checks also require a populated index. Compare matching TMDB document IDs, filter correctness, exclusions and expected relative ordering—not exact `_score` values.

## Troubleshooting

- **TMDB authentication fails:** check `TMDB_API_KEY` in `ingestion/.env`.
- **Elasticsearch unavailable:** run `make up`, inspect `make logs`, and verify `ES_URL`.
- **No search results:** confirm ingestion succeeded and the `movies` index exists with `make index-info`.
- **Mapping changed:** run the guarded reset and reingest data; this deletes the existing configured index.

## Frontend

The Vue 3/Vite UI includes debounced autocomplete with keyboard navigation, a search tips modal, highlighted results, genre and rating filters, browse mode, and pagination. Start it with `make frontend` and open http://localhost:5173.

## License

MIT
