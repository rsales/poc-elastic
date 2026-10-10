# CLAUDE.md — poc-elastic

## What this is
Full-stack movie-search POC: **Elasticsearch 8** + **Node.js/Express API** + **Vue 3/Vite frontend**. Movie data comes from TMDB.
This is the **Node implementation** of a search experiment compared against the Rails one in [`ror-elastic`](https://github.com/rsales/ror-elastic). Both share behavior scenarios in `contracts/search-cases.json`.

Local POC only: Elasticsearch runs single-node with security disabled. Never expose it publicly.

## Layout
```
backend/      Express API (translates request params -> ES Query DSL), has tests
frontend/     Vue 3 + Vite UI (dev server proxies /api/* -> Express :3000)
ingestion/    Node script (seed.js): TMDB fetch -> genre mapping -> ES bulk index
mappings/     movies.json — index mapping + english_analyzer + title.suggest
contracts/    search-cases.json — behavior fixtures shared with ror-elastic
Makefile      Single entry point for all workflows
docker-compose.yml   Elasticsearch + Kibana
```

## Commands (run from repo root)
| Task | Command |
|---|---|
| Full setup (env, infra, deps) | `make setup` |
| Start/stop ES + Kibana | `make up` / `make down` |
| Ingest/update (keeps index) | `make ingest PAGES=25` |
| Recreate index + ingest | `make ingest-reset CONFIRM_RESET=1 PAGES=25` |
| Tests / frontend build / both | `make test` / `make build` / `make verify` |
| Run API / frontend (separate terminals) | `make backend` / `make frontend` |
| Health / index inspection / smoke | `make health` / `make index-info` / `make api-smoke` |

`make help` lists everything. `sync` / `sync-reset` are Rails-compatible aliases of `ingest` / `ingest-reset`.
Helper overrides: `ES_URL`, `BACKEND_URL`, `INDEX`.

## Services
Elasticsearch `:9200` · Kibana `:5601` · Express API `:3000` · Vite `:5173`

## Environment
- `backend/.env`: `PORT` (3000), `ES_URL` (http://localhost:9200), `INDEX` (movies)
- `ingestion/.env`: TMDB v3 API key or v4 Read Access Token (`TMDB_API_KEY`), page count (default 5 pages ≈ 100 records)
- `make setup-env` creates these only if missing. **Never commit `.env` files or credentials.**
- Requires Docker/Compose, Node 18+, npm.

## API (Express, port 3000, no `/api` prefix)
- `GET /health` — 200 if ES reachable, else 503
- `GET /search` — `q`, `genres` (comma-separated, exact), `minRating` (0–10), `from` (>=0, default 0), `size` (1–50, default 20). Response: `hits`, `facets`, `took_ms`
- `GET /suggest?q=&size=` — completion on `title.suggest`, fuzzy, skip duplicates; size 1–10
- `GET /movies/:id` — by TMDB ID; 404 if not indexed
- Invalid params -> 400; unexpected errors -> generic 500.

## Search semantics (keep stable; parity depends on them)
- `simple_query_string`, default operator `OR` (recall). A query with an exclusion (`"Spider-Man" -Homecoming`) switches to `AND`.
- Supports phrases, `+` required, `-` excluded, wildcard prefix, fuzzy, grouping.
- A separate phrase clause **boosts** ranking; it is not mandatory.
- Filters (genres, rating) do not affect scoring.
- Sort: text query = score, popularity, TMDB ID; browse (empty `q`) = popularity, TMDB ID.
- Response includes genre facets, 5-year histogram facets, `<mark>` highlights.

## Index and ingestion
- Index `movies`; TMDB ID is the ES `_id` (re-ingesting updates the same doc).
- Fields: `tmdb_id, title, original_title, short_description, overview, content, genres, year, release_date, original_language, popularity, vote_average, poster_url, poster_path, backdrop_path`.
- Analysis: English stemming + accent folding (`english_analyzer`).
- Ingestion logs failed bulk items with IDs/reasons and exits non-zero on any failure.
- **Mapping changes require recreating the index** (`make ingest-reset CONFIRM_RESET=1`).

## Rules for working in this repo
- `ingest-reset` deletes the index — only run when explicitly intended; it needs `CONFIRM_RESET=1`.
- Don't change the response envelope (`hits`) to match Rails (`items`); parity is checked by document IDs, filter correctness, exclusions and relative ordering — **not** exact `_score`.
- Behavior changes should update `contracts/search-cases.json` and stay compatible with `ror-elastic`.
- Keep Makefile target names aligned with `ror-elastic` where purposes overlap.
- Verify with `make verify`; `make api-smoke` needs the backend running and a populated index.

## Troubleshooting
- TMDB auth error -> check `TMDB_API_KEY` in `ingestion/.env`
- ES unavailable -> `make up`, `make logs`, check `ES_URL`
- No results -> confirm ingestion ran, `make index-info`
- Analyzer debugging: Kibana Dev Tools `POST /movies/_analyze`

## Differences vs ror-elastic
| | poc-elastic | ror-elastic |
|---|---|---|
| Backend | Express | Rails 8 |
| Frontend | Vue 3 + Vite (:5173) | Nuxt 4 (:3001) |
| Ingestion | separate Node script | Rails TMDB sync service |
| Routes | `/search`, `/suggest`, `/health` | `/api/search`, `/api/suggest`, `/api/health` |
| Result key | `hits` | `items` |
| Min rating param | `minRating` | `min_rating` (also `minRating`) |
| Mapping defined in | `mappings/movies.json` | `Movie` model |