# Elasticsearch POC — Full Stack: Infra · Ingestion · Backend · Frontend

## Prerequisites

- Docker and Docker Compose installed
- ~4GB of RAM available for the Elastic container

## Step 1 — Start the cluster

```bash
cd poc-elastic
docker compose up -d
```

Wait ~30-60 seconds for Elastic to become healthy. Verify:

```bash
curl http://localhost:9200
```

You should get a JSON response containing `"cluster_name": "poc-cluster"` and `"version"`.

## Step 2 — Open Kibana

Open in your browser: **http://localhost:5601**

Go to **Management → Dev Tools** (the wrench icon in the side menu). This is where we'll run queries.

### Kibana tips
- `http://localhost:5601/app/dev_tools#/console` is the direct URL to Dev Tools.
- `http://localhost:5601/app/discover` is the Discover tab where you can explore indexed documents with a UI.

## Step 3 — Create the `movies` index

Open `mappings/movies.json` and paste the entire content into Kibana's Dev Tools. Click the play button (▶).

Expected response:

```json
{
  "acknowledged": true,
  "shards_acknowledged": true,
  "index": "movies"
}
```

## Step 4 — Validate the mapping

In Dev Tools, run:

```
GET /movies/_mapping
```

Then test the English analyzer:

```
POST /movies/_analyze
{
  "analyzer": "english_analyzer",
  "text": "The Red Cars are running fast on the highway"
}
```

You should see tokens like `red`, `car`, `run`, `fast`, `highwai` — the stemmer reduced each word to its root and stopwords like `the`, `are`, `on` were removed. This is what makes "running cars" match "car runs" in the search.

## Mapping decisions (the why)

- **`english_analyzer`** chains `english_possessive_stemmer` (strips `'s`) + `lowercase` + `asciifolding` (handles accented imports like "café" → "cafe") + `english` stopwords + `english` stemmer.
- **`title.keyword`** — un-analyzed version, for sorting and exact aggregations.
- **`title.suggest`** — `completion` field for super-fast autocomplete (we'll use it in Part 4).
- **`genres` as keyword** — facets/filters by genre (no full-text needed here).
- **1 shard, 0 replicas** — single-node POC, replication adds no value.

## Part 2 — TMDB ingestion

The `ingestion/` folder contains a Node script that fetches popular movies from the TMDB API and bulk-indexes them into the `movies` index.

### Step 1 — Get a TMDB API key

1. Create a free account at https://www.themoviedb.org.
2. Open **Settings → API** and request a key.
3. Copy the **API Read Access Token (v4)** — this is the long JWT-looking string.

### Step 2 — Configure and install

```bash
cd ingestion
cp .env.example .env
# edit .env and paste your token into TMDB_API_KEY
npm install
```

### Step 3 — Seed the index

```bash
npm run seed -- --reset
```

The `--reset` flag drops and recreates the `movies` index using `mappings/movies.json`, then ingests **5 pages × 20 movies = 100 movies** (the default).

To control the volume, pass `--pages=N` (or set `PAGES=N` in `.env`). Each page is 20 movies:

```bash
npm run seed -- --reset --pages=25     # 500 movies
npm run seed -- --reset --pages=50     # 1000 movies
```

Expected output:

```
ES_URL=http://localhost:9200  INDEX=movies  PAGES=5  RESET=true
→ deleting existing index 'movies'
→ creating index 'movies' from ../mappings/movies.json
→ fetching genre map
  19 genres loaded
  page 1/5: indexed 20/20
  page 2/5: indexed 20/20
  ...
✓ done. indexed=100 failed=0. index 'movies' has 100 docs total.
```

To re-run without wiping the index, omit `--reset` (existing docs with the same `tmdb_id` will be overwritten).

### Step 4 — Verify in Kibana

Refresh the Discover view. You should see ~100 real movies with posters, genres, ratings, etc. Try queries like:

```
title: "spider"
genres: Animation and vote_average > 7
```

Or in Dev Tools (with relevance + highlight):

```
GET /movies/_search
{
  "query": {
    "simple_query_string": {
      "query": "space adventure",
      "fields": ["title^3", "short_description^2", "content^1"],
      "default_operator": "OR"
    }
  },
  "highlight": { "fields": { "title": {}, "short_description": {} } }
}
```

## Part 3 — Express backend (search proxy)

The `backend/` folder is an Express server that sits between the (future) frontend and Elasticsearch. It owns the query DSL and exposes a clean HTTP API.

### Step 1 — Install and run

```bash
cd backend
cp .env.example .env   # adjust PORT/ES_URL if needed
npm install
npm start
```

You should see:

```
backend listening on http://localhost:3000
  GET /health
  GET /search?q=...&genres=Action,Drama&minRating=7&from=0&size=20
  GET /suggest?q=spi&size=5
  GET /movies/:id
```

Use `npm run dev` to auto-reload on file changes (uses `node --watch`).

### Step 2 — Try it

```bash
# Health (also reports ES cluster status)
curl http://localhost:3000/health

# Search with a typo — fuzzy AUTO + per-field boosts
curl "http://localhost:3000/search?q=avengrs&size=3" | jq

# Filter combo: war movies, Action genre, rating ≥ 7
curl "http://localhost:3000/search?q=war&genres=Action&minRating=7" | jq

# Browse without query (sorted by popularity desc)
curl "http://localhost:3000/search?size=5" | jq '.hits[] | {title, popularity, year}'

# Autocomplete via the title.suggest completion field
curl "http://localhost:3000/suggest?q=spi" | jq

# Get a single movie by tmdb_id
curl http://localhost:3000/movies/634649 | jq '{title, year, vote_average}'
```

### Endpoint contract

**`GET /search`**

| Param       | Type    | Default | Notes                                                         |
| ----------- | ------- | ------- | ------------------------------------------------------------- |
| `q`         | string  | —       | Empty → returns all docs sorted by `popularity` desc.         |
| `genres`    | string  | —       | Comma-separated keyword filter (`Action,Drama`).              |
| `minRating` | number  | —       | `vote_average >= minRating`.                                  |
| `from`      | int     | `0`     | Pagination offset.                                            |
| `size`      | int     | `20`    | Page size, capped at 50.                                      |

Response shape:

```json
{
  "total": 100,
  "took_ms": 12,
  "hits": [
    { "id": "634649", "score": 11.67, "title": "...", "year": 2021,
      "highlight": { "title": ["<mark>Avengers</mark>"] }, ... }
  ],
  "facets": {
    "genres": [{ "value": "Drama", "count": 33 }, ...],
    "years":  [{ "value": 2025, "count": 67 }, ...]
  }
}
```

**`GET /suggest?q=&size=`** → autocomplete via `title.suggest` (completion). Returns title + id + year + poster URL — perfect for a typeahead dropdown.

**`GET /movies/:id`** → fetch a single doc, or 404.

### Design notes

- The query DSL (`simple_query_string`, boosts, highlight, aggregations) lives in `searchService.js`. Tweaking relevance is a one-file change — the frontend doesn't need to know.
- `bool.must` carries the relevance clause; `bool.filter` carries `genres` and `minRating` so they don't pollute the `_score`.
- Highlights wrap matches in `<mark>` (HTML-friendly for the future Vue UI).
- CORS is enabled wide-open (`cors()`); for production you'd lock it to specific origins.
- `/search` without `q` falls back to `match_all` sorted by `popularity` — gives the frontend a sensible "browse" mode.

## Part 4 — Vue 3 + Vite frontend

The `frontend/` folder is a Vite + Vue 3 single-page app that consumes the backend API. It demonstrates the full search experience end-to-end.

### Step 1 — Run

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173.

> The Vite dev server proxies `/api/*` to the backend on `localhost:3000` (see `vite.config.js`), so the frontend code only ever talks to its own origin — no CORS gymnastics in development.

### What you can demo

- **Search input with debounced autocomplete** (250ms) — type `spi` and the dropdown shows posters from `/suggest`. Arrow keys navigate, Enter selects.
- **Search tips modal** — click the "ℹ️ Search tips" link below the search bar to open a reference modal documenting all available Google-style operators (`"phrase"`, `+required`, `-exclude`, `term*`, `term~N`, `|`, groups).
- **Results grid** with poster, title, year, rating badge, genre tags, and `_score` shown next to each card so reviewers can *see* the relevance signal moving.
- **Highlighted matches** — `<mark>` tags from the backend's `highlight` block are rendered inline in titles and descriptions.
- **Faceted filters** — genres are checkboxes (counts shown next to each), and rating is a slider. Selecting any filter re-runs the search at offset 0.
- **Browse mode** — empty query falls back to `match_all` sorted by `popularity desc`. Loads on first paint.
- **Pagination** — Previous/Next at the bottom; jumps back to top when navigating.

### File layout

```
frontend/
├── index.html
├── package.json
├── vite.config.js              # /api proxy to backend
└── src/
    ├── main.js                 # mounts App
    ├── style.css               # CSS variables (dark theme) + base
    ├── api.js                  # fetch wrappers around /search and /suggest
    ├── App.vue                 # owns query/filters/pagination state
    └── components/
        ├── SearchBar.vue       # input + autocomplete dropdown + "Search tips" link
        ├── SearchHelpModal.vue # modal: reference table of search operators
        ├── FacetSidebar.vue    # genre checkboxes + rating slider
        ├── MovieGrid.vue       # results grid container
        └── MovieCard.vue       # poster, highlighted title/desc, score, tags
```

### Design notes

- All page state lives in `App.vue`. Children receive props and emit changes — no Vuex/Pinia for a 4-screen app.
- `MovieCard` uses `v-html` to render the highlight HTML from the backend. Source is the trusted `<mark>` tag from ES; user-supplied data is escaped before being merged in.
- `aspect-ratio: 2 / 3` on poster slots avoids layout shift when images load lazily.

## Putting it all together

A full demo run from a clean checkout:

```bash
# Terminal 1 — infra
docker compose up -d

# Terminal 2 — load real data
cd ingestion && cp .env.example .env  # fill TMDB_API_KEY
npm install && npm run seed -- --reset --pages=25  # 500 movies indexed

# Terminal 3 — backend
cd backend && cp .env.example .env
npm install && npm start

# Terminal 4 — frontend
cd frontend && npm install && npm run dev
```

Then open http://localhost:5173.

## Search contract refinements

The `refine/search-contract` branch tightens the API contract while preserving the response envelope used by the Vue frontend.

- `GET /search`: `from` must be a non-negative integer, `size` must be between 1 and 50, and `minRating` must be between 0 and 10. Invalid input returns HTTP 400 instead of silently reverting to a default.
- `GET /suggest`: `size` must be between 1 and 10. A blank query still returns an empty suggestions array.
- Unexpected backend errors return a generic HTTP 500 body; validation errors return HTTP 400 with a safe message.
- Plain-term queries use OR semantics. Required/excluded terms and phrase, wildcard, and fuzzy syntax are expressed by `simple_query_string`; phrase matching contributes a ranking boost rather than a mandatory condition.
- Browse and search use stable tie-breaks based on the mapped `tmdb_id` field. Scores remain implementation-specific and should not be compared as exact values across search engines.
- TMDB ingestion now retains `overview`, `original_title`, `original_language`, `poster_path`, and `backdrop_path` alongside legacy frontend fields (`short_description` and `poster_url`) to ease comparison with the Rails POC.
- Per-document bulk errors are logged with IDs, and an ingestion run with any failed records exits non-zero.

Run the backend validation tests:

```bash
cd backend
npm test
```

Shared behavior cases for comparing with `ror-elastic` live in `contracts/search-cases.json`. Compare matching document IDs and expected ordering, not exact Elasticsearch `_score` values.

The tests do not replace integration checks against Elasticsearch and TMDB. Recreate the index after mapping changes:

```bash
cd ingestion
npm run seed -- --reset
```

## Local workflow with Makefile

The root `Makefile` collects the local setup, ingestion, and verification commands. Run commands from the repository root.

### First-time setup

```bash
make setup
```

This creates `ingestion/.env` and `backend/.env` from the examples only when they do not exist, then installs dependencies in the backend, ingestion, and frontend. Set `TMDB_API_KEY` in `ingestion/.env` before ingesting. The script supports a TMDB v4 read token or a v3 API key.

### Start Elasticsearch and Kibana

```bash
make up
make wait-es
make status
```

Elasticsearch is available at `http://localhost:9200` and Kibana at `http://localhost:5601`.

### Ingest movies

For a first load, create the index and ingest 100 movies (5 pages × 20):

```bash
make reindex CONFIRM_RESET=1
```

To ingest 500 movies instead:

```bash
make reindex CONFIRM_RESET=1 PAGES=25
```

**Warning:** `reindex` passes `--reset`, which deletes and recreates the configured index before ingestion. Use `make ingest PAGES=5` to add/update documents without deleting the index, provided the index already exists. The ingestion script uses stable TMDB IDs, so reruns update the same movie documents.

### Test and run the app

```bash
make test
make verify
```

`make test` runs the backend validation unit tests; `make verify` runs those tests and builds the Vue frontend. Start the backend and frontend in separate terminals:

```bash
make backend-dev
make frontend-dev
```

Open `http://localhost:5173`. With both servers running and data ingested, run the API smoke checks from another terminal:

```bash
make smoke
```

Other helpful commands: `make help`, `make logs`, and `make down`. `make down` stops the containers but preserves the named Elasticsearch data volume; it does not delete the index.

