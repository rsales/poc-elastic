import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@elastic/elasticsearch';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TMDB_API_KEY = (process.env.TMDB_API_KEY || '').trim();
const ES_URL = process.env.ES_URL || 'http://localhost:9200';
const INDEX = process.env.INDEX || 'movies';

const pagesArg = process.argv.find(a => a.startsWith('--pages='));
const PAGES = pagesArg
  ? Number.parseInt(pagesArg.split('=')[1], 10)
  : Number.parseInt(process.env.PAGES || '5', 10);
const RESET = process.argv.includes('--reset');

const TMDB_BASE = 'https://api.themoviedb.org/3';
const POSTER_BASE = 'https://image.tmdb.org/t/p/w342';
const MAPPING_FILE = path.resolve(__dirname, '../mappings/movies.json');

if (!TMDB_API_KEY) {
  console.error('ERROR: TMDB_API_KEY missing. Copy .env.example to .env and fill it in.');
  process.exit(1);
}
if (!Number.isInteger(PAGES) || PAGES < 1 || PAGES > 500) {
  console.error('ERROR: PAGES must be an integer between 1 and 500.');
  process.exit(1);
}

const IS_V4_TOKEN = TMDB_API_KEY.startsWith('eyJ');

const tmdb = async (endpoint, params = {}) => {
  const url = new URL(`${TMDB_BASE}${endpoint}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const headers = { accept: 'application/json' };
  if (IS_V4_TOKEN) headers.Authorization = `Bearer ${TMDB_API_KEY}`;
  else url.searchParams.set('api_key', TMDB_API_KEY);

  const r = await fetch(url, { headers });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`TMDB ${endpoint} -> HTTP ${r.status}${body ? ` :: ${body.slice(0, 200)}` : ''}`);
  }
  return r.json();
};

const es = new Client({ node: ES_URL });

const loadMappingBody = () => {
  const raw = fs.readFileSync(MAPPING_FILE, 'utf-8');
  return JSON.parse(raw.replace(/^[A-Z]+\s+\/\S+\s*\n/, ''));
};

const resetIndex = async () => {
  const exists = await es.indices.exists({ index: INDEX });
  if (exists) {
    console.log(`→ deleting existing index '${INDEX}'`);
    await es.indices.delete({ index: INDEX });
  }
  const body = loadMappingBody();
  console.log(`→ creating index '${INDEX}' from ${path.relative(process.cwd(), MAPPING_FILE)}`);
  await es.indices.create({ index: INDEX, ...body });
};

const buildDoc = (m, genreMap) => {
  const genreNames = (m.genre_ids || []).map(id => genreMap[id]).filter(Boolean);
  const contentParts = [
    genreNames.join(' '),
    m.original_title && m.original_title !== m.title ? m.original_title : '',
    m.original_language ? `language ${m.original_language}` : ''
  ].filter(Boolean);
  return {
    tmdb_id: String(m.id),
    title: m.title,
    short_description: m.overview || '',
    content: contentParts.join(' | '),
    genres: genreNames,
    year: m.release_date ? Number.parseInt(m.release_date.slice(0, 4), 10) : null,
    release_date: m.release_date || null,
    popularity: m.popularity ?? null,
    vote_average: m.vote_average ?? null,
    poster_url: m.poster_path ? `${POSTER_BASE}${m.poster_path}` : null
  };
};

const main = async () => {
  console.log(`ES_URL=${ES_URL}  INDEX=${INDEX}  PAGES=${PAGES}  RESET=${RESET}`);
  await es.ping().catch(() => {
    throw new Error(`Cannot reach Elasticsearch at ${ES_URL}. Is the docker stack up?`);
  });

  if (RESET) await resetIndex();

  console.log('→ fetching genre map');
  const { genres } = await tmdb('/genre/movie/list', { language: 'en-US' });
  const genreMap = Object.fromEntries(genres.map(g => [g.id, g.name]));
  console.log(`  ${Object.keys(genreMap).length} genres loaded`);

  let totalIndexed = 0;
  let totalFailed = 0;
  const failures = [];

  for (let page = 1; page <= PAGES; page++) {
    const data = await tmdb('/movie/popular', { language: 'en-US', page });
    if (!data.results?.length) {
      console.log(`  page ${page} empty, stopping`);
      break;
    }

    const operations = data.results.flatMap(m => {
      const doc = buildDoc(m, genreMap);
      return [{ index: { _index: INDEX, _id: doc.tmdb_id } }, doc];
    });
    const resp = await es.bulk({ refresh: false, operations });

    const failed = resp.errors
      ? resp.items.flatMap((item, index) => item.index?.error
          ? [{ id: operations[index * 2]?.index?._id, reason: item.index.error.reason }]
          : [])
      : [];
    totalIndexed += data.results.length - failed.length;
    totalFailed += failed.length;
    failures.push(...failed);

    console.log(`  page ${page}/${PAGES}: indexed ${data.results.length - failed.length}/${data.results.length}` +
      (failed.length ? ` (failed: ${failed.length}, e.g. "${failed[0].reason}")` : ''));
  }

  await es.indices.refresh({ index: INDEX });
  const { count } = await es.count({ index: INDEX });
  console.log(`✓ done. indexed=${totalIndexed} failed=${totalFailed}. index '${INDEX}' has ${count} docs total.`);

  if (failures.length) {
    console.error('Failed documents (first 20):', JSON.stringify(failures.slice(0, 20), null, 2));
    process.exitCode = 1;
  }
};

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exitCode = 1;
}).finally(async () => {
  await es.close().catch(() => {});
});
