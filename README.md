# Elasticsearch POC

A full-stack proof of concept for movie search with **Elasticsearch 8**, a **Node.js/Express API**, and a **Vue 3 + Vite frontend**. Movie data is ingested from TMDB.

The repository demonstrates index mapping and analysis, bulk ingestion, full-text search, relevance boosts, filters, facets, highlighting, autocomplete, and a small search UI.

## Prerequisites

- Docker and Docker Compose
- Node.js 18 or newer and npm
- A TMDB API key or API Read Access Token
- `jq` for the optional terminal examples that pipe responses through `jq`

Elasticsearch is configured for a local, single-node POC and has security disabled. **Do not expose this setup to a public network or use it as a production deployment.**

## Quick start

Run the commands below from the repository root.

### 1. Configure environment variables

Create local environment files from the examples:

```bash
cp ingestion/.env.example ingestion/.env
cp backend/.env.example backend/.env
```

Edit `ingestion/.env` and set `TMDB_API_KEY`. The ingestion script accepts a TMDB v4 Read Access Token or a v3 API key. Keep local `.env` files private; never commit credentials.

### 2. Start services and install dependencies

```bash
make setup
```

This starts Elasticsearch and Kibana through Docker Compose and installs dependencies for the ingestion script, backend, and frontend.

Wait for Elasticsearch to become ready:

```bash
make health
curl -s http://localhost:9200/_cluster/health | jq
```

Default local URLs:

| Service | URL |
| --- | --- |
| Elasticsearch | http://localhost:9200 |
| Kibana | http://localhost:5601 |
| Backend API | http://localhost:3000 |
| Frontend | http://localhost:5173 |

### 3. Ingest movie data

For a first run, recreate the index and ingest the default five TMDB pages (usually about 100 movies):

```bash
make ingest-reset
```

**Warning:** `make ingest-reset` deletes and recreates the configured index before ingesting data. Use it only when replacing the existing contents is acceptable. The index mapping is loaded from `mappings/movies.json`.

To ingest or update movies without deleting the index:

```bash
make ingest
```

The `ingest` target requires the index to already exist. Both modes use each movie's TMDB ID as the Elasticsearch document ID, so re-ingesting the same movie updates the existing document rather than creating a duplicate.

The default page count is configured by `PAGES=5` in `ingestion/.env`; each TMDB page contains up to 20 movies. For example, set `PAGES=25` for about 500 movies. You can also pass an explicit page count directly:

```bash
cd ingestion
npm run seed -- --reset --pages=25
```

### 4. Test the backend and run the app

Run the backend's validation tests:

```bash
make test
```

Start the backend and frontend in **separate terminals**:

```bash
make backend
```

```bash
make frontend
```

Open http://localhost:5173.

The Vite dev server proxies requests from `/api/*` to the backend at `http://localhost:3000`. To stop a foreground process, press `Ctrl+C`.

## Makefile commands

Run `make` or inspect the root `Makefile` to see the available targets.

| Command | Description |
| --- | --- |
| `make setup` | Start Docker services and install all npm dependencies |
| `make up` | Start Elasticsearch and Kibana |
| `make down` | Stop containers; preserves the named Elasticsearch data volume |
| `make logs` | Follow Docker Compose logs |
| `make health` | Request the Elasticsearch root endpoint |
| `make elastic` | Open Elasticsearch in the browser (macOS) |
| `make kibana` | Open Kibana in the browser (macOS) |
| `make install` | Install backend, ingestion, and frontend dependencies |
| `make test` | Run backend tests |
| `make ingest` | Ingest/update data without resetting the index |
| `make ingest-reset` | Delete and recreate the index, then ingest data |
| `make backend` | Start the Express backend |
| `make frontend` | Start the Vite development server |

## Ingestion details

The script in `ingestion/seed.js` fetches the TMDB genre list and popular-movie pages, maps genre IDs to names, prepares each document, and bulk-indexes the documents into Elasticsearch. It refreshes the index after ingestion and reports the document count.

Indexed documents include fields such as:

- `tmdb_id`, `title`, `original_title`
- `short_description` and `overview` (both retained for compatibility)
- `content`, `genres`, `original_language`
- `year`, `release_date`, `popularity`, `vote_average`
- `poster_url`, `poster_path`, `backdrop_path`

Bulk item failures are reported with document IDs and reasons. If any documents fail to index, the script exits with a non-zero status.

## Elasticsearch mapping and analysis

The index definition is in `mappings/movies.json`. It is written in Kibana Console format and begins with `PUT /movies`. Normally, `make ingest-reset` creates the index automatically. To inspect or create the index manually, open Kibana Dev Tools at [http://localhost:5601/app/dev_tools#/console](http://localhost:5601/app/dev_tools#/console) and run the mapping request.

### Validate the mapping

In Kibana Dev Tools:

```http
GET /movies/_mapping
```

### Test the analyzer

```http
POST /movies/_analyze
{
  "analyzer": "english_analyzer",
  "text": "The Red Cars are running fast on the highway"
}
```

The analyzer applies possessive stemming, lowercasing, ASCII folding, English stopword removal, and English stemming. This helps searches match related forms such as `cars` and `car`, and handles many accented characters such as `café` and `cafe`.

Mapping highlights:

- `title.keyword` stores an exact-value subfield of a title.
- `title.suggest` is a completion field used by autocomplete.
- `genres` is a keyword field for filters and genre facets.
- The index uses one shard and zero replicas for the local single-node POC.

## Backend API

The Express server in `backend/` exposes a small HTTP interface on port 3000. Configure `PORT`, `ES_URL`, and `INDEX` through `backend/.env`; defaults are `3000`, `http://localhost:9200`, and `movies`.

### Health check

```bash
curl -i http://localhost:3000/health
```

Returns HTTP 200 when Elasticsearch is reachable and HTTP 503 when it is not.

### Search

`GET /search`

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `q` | string | empty | Text query. An empty query browses all documents sorted by popularity. |
| `genres` | string | empty | Comma-separated exact genre filters, for example `Action,Drama`. |
| `minRating` | number | none | Minimum `vote_average`, from 0 to 10. |
| `from` | integer | `0` | Non-negative pagination offset. |
| `size` | integer | `20` | Page size from 1 to 50. |

Example requests:

```bash
# Search
curl -s "http://localhost:3000/search?q=space%20adventure&size=5" | jq

# Search with filters
curl -s "http://localhost:3000/search?q=war&genres=Action,Drama&minRating=7" | jq

# Browse by popularity
curl -s "http://localhost:3000/search?size=5" | jq '.hits[] | {title, popularity, year}'
```

A successful response has this general shape:

```json
{
  "total": 100,
  "took_ms": 12,
  "hits": [
    {
      "id": "634649",
      "score": 11.67,
      "title": "...",
      "year": 2021,
      "highlight": {
        "title": ["<mark>Avengers</mark>"]
      }
    }
  ],
  "facets": {
    "genres": [{ "value": "Drama", "count": 33 }],
    "years": [{ "value": 2025, "count": 67 }]
  }
}
```

The example is illustrative; actual counts, scores, and results depend on the indexed dataset. The `hits` array contains document fields plus `id`, `score`, and `highlight`.

### Search behavior and relevance

- Plain terms use `simple_query_string` with `OR` semantics for broad recall.
- Explicit syntax can express phrases, required terms (`+`), excluded terms (`-`), wildcards, and fuzzy terms.
- A phrase match adds a ranking boost; it is not a mandatory condition.
- Genre and rating constraints are filters and do not directly add to the relevance score.
- Results are sorted by score first for text queries, with popularity and `tmdb_id` tie-breakers. Browse mode sorts by popularity and then `tmdb_id`.
- Exact `_score` values are Elasticsearch-specific; use matching document IDs and expected ordering when comparing this POC with another search implementation.

### Facets and highlighting

Search responses include:

- `facets.genres`: genre names and document counts.
- `facets.years`: five-year histogram buckets.
- `highlight`: matching title and overview/description fragments wrapped in `<mark>` tags.

### Suggestions

`GET /suggest?q=spi&size=5`

Autocomplete uses the `title.suggest` completion field with duplicate suggestions removed and fuzzy completion enabled. The `size` parameter must be between 1 and 10. A blank query returns an empty `suggestions` array.

```bash
curl -s "http://localhost:3000/suggest?q=spi" | jq
```

### Get a movie by ID

`GET /movies/:id` returns a movie document or HTTP 404 when there is no matching document. The ID is the TMDB ID used when the movie is indexed.

```bash
curl -i http://localhost:3000/movies/634649
```

### Validation errors

Invalid parameters return HTTP 400. For example:

```bash
curl -i "http://localhost:3000/search?from=-1"
curl -i "http://localhost:3000/search?size=51"
curl -i "http://localhost:3000/search?minRating=11"
curl -i "http://localhost:3000/suggest?q=spi&size=11"
```

Unexpected backend errors return a generic HTTP 500 response rather than exposing raw Elasticsearch details.

## Frontend

The Vue 3 + Vite frontend demonstrates the end-to-end search experience.

```bash
make frontend
```

Open http://localhost:5173. The UI includes:

- Debounced autocomplete with posters; arrow-key navigation and Enter selection.
- A search tips modal describing supported query operators.
- A results grid with poster, title, year, rating, genres, highlights, and score.
- Genre checkboxes and a minimum-rating slider.
- Browse mode for an empty query.
- Pagination.

Key files:

```text
frontend/
├── index.html
├── package.json
├── vite.config.js
└── src/
    ├── main.js
    ├── style.css
    ├── api.js
    ├── App.vue
    └── components/
        ├── SearchBar.vue
        ├── SearchHelpModal.vue
        ├── FacetSidebar.vue
        ├── MovieGrid.vue
        └── MovieCard.vue
```

## Local verification checklist

Run these steps after a fresh checkout or after changing the mapping:

```bash
# 1. Configure local env files first (see Quick start)
make setup

# 2. Recreate the index and load data (destructive)
make ingest-reset

# 3. Run backend unit tests
make test

# 4. In separate terminals, start the backend and frontend
make backend
make frontend
```

Then verify:

1. `http://localhost:5173` loads the search UI.
2. `curl -i http://localhost:3000/health` reports the Elasticsearch connection.
3. `/search?size=5` returns hits and facets.
4. `/suggest?q=spi` returns suggestions if matching titles are indexed.
5. Invalid parameters return HTTP 400.
6. `/movies/634649` returns the movie when that TMDB ID is present in the indexed pages.

The unit tests do not require a live Elasticsearch cluster. The end-to-end checks do require Elasticsearch to be running and the TMDB ingestion to have succeeded.
