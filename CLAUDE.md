# CLAUDE.md — poc-elastic

## What this is
Movie-search POC: **Elasticsearch 8.13** + **Node.js/Express 4 API** + **Vue 3/Vite frontend**, data from TMDB. Plain JavaScript (ES modules, no TypeScript).
It is the Node half of a comparison with [`ror-elastic`](https://github.com/rsales/ror-elastic) (Rails 8 + Nuxt 4). Both must keep the same search behavior.

Local POC only: ES runs single-node with security disabled. Never expose it publicly.

## Layout
```
backend/
  server.js          Express app: routes, error middleware (4xx -> message, else generic 500)
  searchService.js   ES client + search() / suggest() / getById() (Query DSL lives here)
  querySemantics.js  getDefaultOperator(): AND if query has an exclusion (-term), else OR
  validation.js      queryScalar / parseInteger / parseRating (throw Error with .status = 400)
  test/contract.test.js   node:test unit tests (validation + operator only)
frontend/src/        App.vue, api.js, components/{SearchBar,FacetSidebar,MovieGrid,MovieCard,SearchHelpModal}.vue
ingestion/seed.js    TMDB fetch -> genre map -> bulk index; flags: --pages=N, --reset
mappings/movies.json Index settings + mapping (Kibana-console format, see gotchas)
contracts/search-cases.json   Shared behavior scenarios (prose expectations)
Makefile, docker-compose.yml
```

## Commands (from repo root)
| Task | Command |
|---|---|
| Setup everything | `make setup` |
| Start/stop ES + Kibana | `make up` / `make down` (volume preserved) |
| Ingest, keep index | `make ingest PAGES=25` |
| Recreate index + ingest | `make ingest-reset CONFIRM_RESET=1 PAGES=25` |
| Backend tests / frontend build / both | `make test` / `make build` / `make verify` |
| Run API / UI (separate terminals) | `make backend` / `make frontend` |
| Health / index info / smoke | `make health` / `make index-info` / `make api-smoke` |

`sync` and `sync-reset` are aliases for `ingest` / `ingest-reset`. `make help` lists all targets. Overrides: `ES_URL`, `BACKEND_URL`, `INDEX`.
Backend tests run with `cd backend && npm test` (`node --test`). Dev server with auto-reload: `npm run dev` in `backend/`.

## Services
ES `:9200` · Kibana `:5601` · API `:3000` · Vite `:5173` (proxies `/api/*` -> `:3000`, stripping `/api`).

## Environment
- `backend/.env`: `PORT=3000`, `ES_URL=http://localhost:9200`, `INDEX=movies`
- `ingestion/.env`: `TMDB_API_KEY`, `ES_URL`, `INDEX`, `PAGES=5` (20 movies/page; allowed 1–500)
- TMDB key starting with `eyJ` is treated as a v4 Bearer token; anything else is sent as a v3 `api_key` query param.
- `make setup-env` only creates missing files. Never commit `.env` or credentials.
- Needs Docker/Compose, Node >= 18, npm.

## API (no `/api` prefix; the prefix exists only in the Vite proxy)
- `GET /health` — 200 `{status:'ok', es}` or 503 `{status:'degraded'}`
- `GET /search` — `q`, `genres` (comma list, exact keyword match), `minRating` (0–10), `from` (>=0), `size` (1–50, default 20). Returns `{ total, took_ms, hits[], facets: { genres[], years[] } }`; each hit = `{ id, score, ...source, highlight }`
- `GET /suggest?q=&size=` — `{ suggestions: [{ text, id, title, year, poster_url }] }`, size 1–10 (default 5); empty `q` returns empty list
- `GET /movies/:id` — by TMDB ID; 404 `{error:'not found'}`
- Validation errors -> 400 with message; anything else -> 500 `{error:'internal server error'}`

## Search semantics (shared contract — keep in sync with ror-elastic)
- `bool.must` = `simple_query_string` over `title^3, short_description^2, overview^2, content^1`, `lenient: true`; empty `q` = `match_all`.
- Default operator `OR`; `AND` when the query matches `/(^|\s)-\S/` (so `"Spider-Man" -Homecoming` keeps the positive clause mandatory).
- `bool.should` = phrase `multi_match` (slop 1, boost 2) over title/short_description/overview — a ranking boost only.
- Filters (`terms` on `genres`, `range` on `vote_average`) go in `bool.filter`, so they don't affect score.
- Sort: text = `_score desc, popularity desc, tmdb_id asc`; browse = `popularity desc, tmdb_id asc`.
- Aggs: `by_genre` (terms, size 15), `by_year` (histogram, interval 5, min_doc_count 1). Highlight uses `<mark>`.
- Suggest: completion on `title.suggest`, `skip_duplicates`, fuzziness `AUTO`.

## Index and ingestion
- Index `movies`, 1 shard / 0 replicas; `_id` = TMDB ID (re-ingest upserts).
- `english_analyzer`: standard tokenizer -> possessive stemmer, lowercase, asciifolding, English stop, English stemmer.
- Fields: `tmdb_id` (keyword), `title` (text + `.keyword` + `.suggest` completion), `original_title`, `short_description`, `overview`, `content` (text), `genres`/`original_language` (keyword), `year` (int), `release_date` (date), `popularity`/`vote_average` (float), `poster_url`/`poster_path`/`backdrop_path` (keyword, not indexed).
- `short_description` is a copy of `overview`; `content` = genre names | original title (if different) | `language xx`.
- Bulk indexing per page; failed items are logged (first 20 with id + reason) and the process exits non-zero. Final doc count comes from `_count` after refresh.

## Rules for working here
- `ingest-reset` deletes the index and requires `CONFIRM_RESET=1`. Never run it unprompted. Mapping changes need a reset + re-ingest.
- Keep the `hits` envelope. Parity with Rails is judged on matching document IDs, filters, exclusions and relative ordering — not `_score`.
- If you change query semantics, change `searchService.js` **and** `querySemantics.js`, update `contracts/search-cases.json`, and apply the same change in `ror-elastic`.
- Add validation through `validation.js` helpers so errors carry `status = 400`.
- Keep Makefile target names aligned with ror-elastic.

## Gotchas
- `mappings/movies.json` starts with a `PUT /movies` line (Kibana Dev Tools format). `seed.js` strips that first line before parsing — don't turn the file into plain JSON without updating `loadMappingBody()`, and don't remove the line without checking Kibana usage.
- `tmdb_id` is a keyword, so the `tmdb_id asc` tie-breaker is lexicographic, not numeric. Fine for determinism, not for numeric order.
- Tests do not hit Elasticsearch: only validation and operator selection are covered. `contracts/search-cases.json` is descriptive prose and is **not** executed by any test; `make api-smoke` is a manual check.
- No frontend tests. The UI only renders the genre facet; the `years` facet is returned but unused.
- `ingestion/.env.example` comments mention a v4 token only, but v3 keys also work (see above).
- ror-elastic's compose uses the same host ports (9200, 5601) and the API also uses 3000, so both stacks cannot run at the same time.
- Docker config sets ES heap to 2 GB (`mem_limit: 3g`); lower it on small Docker VMs.

## Differences vs ror-elastic
| | poc-elastic | ror-elastic |
|---|---|---|
| Backend | Express 4 | Rails 8.1 (API-only) |
| Frontend | Vue 3 + Vite, JS (:5173) | Nuxt 4, TypeScript (:3001) |
| Ingestion | Node script, ES bulk | Rails service, per-record SQLite save + ES index |
| Routes | `/search`, `/suggest`, `/health`, `/movies/:id` | same under `/api` |
| Result key | `hits` | `items` |
| Min rating param | `minRating` | `min_rating` (also `minRating`) |
| Mapping defined in | `mappings/movies.json` | `Movie` model |
| Malformed query (by code reading) | ES error likely surfaces as 500 | ES 400 returns an empty 200 response |
| ES heap | 2 GB | 1 GB |