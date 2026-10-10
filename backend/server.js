import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { search, suggest, getById, es } from './searchService.js';
import { queryScalar, parseInteger, parseRating } from './validation.js';

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}

const app = express();
app.use(cors());
app.use(express.json());

app.use((req, _res, next) => {
  req._start = Date.now();
  next();
});

app.get('/health', async (_req, res) => {
  const cluster = await es.cluster.health().catch(() => null);
  const reachable = Boolean(cluster);
  res.status(reachable ? 200 : 503).json({
    status: reachable ? 'ok' : 'degraded',
    es: cluster?.status || 'unreachable'
  });
});

app.get('/search', async (req, res, next) => {
  try {
    const q = queryScalar(req.query.q, 'q') ?? '';
    const genresValue = queryScalar(req.query.genres, 'genres') ?? '';
    const minRatingValue = queryScalar(req.query.minRating, 'minRating');
    const fromValue = queryScalar(req.query.from, 'from');
    const sizeValue = queryScalar(req.query.size, 'size');

    const from = parseInteger(fromValue, { name: 'from', defaultValue: 0, min: 0 });
    const size = parseInteger(sizeValue, { name: 'size', defaultValue: 20, min: 1, max: 50 });
    const minRating = parseRating(minRatingValue);
    const genres = genresValue.split(',').map(s => s.trim()).filter(Boolean);

    const result = await search({ q: q.trim(), genres, minRating, from, size });
    console.log(`GET /search q="${q}" genres="${genresValue}" min=${minRating ?? '-'} hits=${result.total} took=${Date.now() - req._start}ms`);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

app.get('/suggest', async (req, res, next) => {
  try {
    const q = (queryScalar(req.query.q, 'q') ?? '').trim();
    const sizeValue = queryScalar(req.query.size, 'size');
    const size = parseInteger(sizeValue, { name: 'size', defaultValue: 5, min: 1, max: 10 });
    const result = await suggest({ q, size });
    console.log(`GET /suggest q="${q}" results=${result.suggestions.length} took=${Date.now() - req._start}ms`);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

app.get('/movies/:id', async (req, res, next) => {
  try {
    const result = await getById(req.params.id);
    if (!result) return res.status(404).json({ error: 'not found' });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

app.use((err, _req, res, _next) => {
  const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status >= 500) console.error('ERROR:', err.message);
  res.status(status).json({
    error: status === 500 ? 'internal server error' : err.message
  });
});

app.listen(PORT, () => {
  console.log(`backend listening on http://localhost:${PORT}`);
  console.log('  GET /health');
  console.log('  GET /search?q=...&genres=Action,Drama&minRating=7&from=0&size=20');
  console.log('  GET /suggest?q=spi&size=5');
  console.log('  GET /movies/:id');
});
