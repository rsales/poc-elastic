#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contract = JSON.parse(await readFile(path.join(root, 'contracts/search-cases.json'), 'utf8'));
const mapping = JSON.parse(await readFile(path.join(root, 'contracts/fixtures/index-mapping.json'), 'utf8'));
const documents = JSON.parse(await readFile(path.join(root, 'contracts/fixtures/movies.json'), 'utf8'));

const trimSlash = value => value.replace(/\/+$/, '');
const nodeBase = trimSlash(process.env.NODE_API_URL || 'http://localhost:3000');
const railsBase = trimSlash(process.env.RAILS_API_URL || 'http://localhost:3100');
const esBase = trimSlash(process.env.CONTRACT_ES_URL || process.env.ES_URL || process.env.ELASTICSEARCH_URL || 'http://localhost:9200');
const index = process.env.CONTRACT_INDEX || 'movies-contract-test';
const setupIndex = process.env.CONTRACT_SETUP_INDEX === '1';
const pageSize = 50;

function assertContractIndexName() {
  if (!index.endsWith('-contract-test')) {
    throw new Error(`Refusing to seed index "${index}". Contract setup is restricted to names ending in "-contract-test".`);
  }
}

async function responseError(response) {
  const body = await response.text().catch(() => '');
  return `HTTP ${response.status} ${response.statusText}${body ? `: ${body.slice(0, 1000)}` : ''}`;
}

async function seedContractIndex() {
  assertContractIndexName();
  const indexUrl = `${esBase}/${encodeURIComponent(index)}`;
  const deleted = await fetch(indexUrl, { method: 'DELETE' });
  if (!deleted.ok && deleted.status !== 404) {
    throw new Error(`Could not recreate isolated contract index: ${await responseError(deleted)}`);
  }

  const created = await fetch(indexUrl, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(mapping)
  });
  if (!created.ok) throw new Error(`Could not create contract index: ${await responseError(created)}`);

  const lines = [];
  for (const doc of documents) {
    lines.push(JSON.stringify({ index: { _index: index, _id: String(doc.tmdb_id) } }));
    lines.push(JSON.stringify(doc));
  }
  const bulk = await fetch(`${esBase}/_bulk?refresh=true`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-ndjson' },
    body: `${lines.join('\n')}\n`
  });
  if (!bulk.ok) throw new Error(`Bulk fixture indexing failed: ${await responseError(bulk)}`);
  const payload = await bulk.json();
  if (payload.errors) {
    const failed = payload.items.filter(item => item.index?.error).slice(0, 5);
    throw new Error(`Bulk fixture indexing reported errors: ${JSON.stringify(failed)}`);
  }
  console.log(`Seeded ${documents.length} deterministic documents in ${esBase}/${index}.`);
}

function routeFor(api, type) {
  if (type === 'search') return api.kind === 'node' ? '/search' : '/api/search';
  return api.kind === 'node' ? '/suggest' : '/api/suggest';
}

function queryUrl(api, type, params) {
  const url = new URL(routeFor(api, type), api.base);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  return url;
}

async function callApi(api, type, params) {
  const url = queryUrl(api, type, params);
  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new Error(`${api.name} ${url} failed to connect: ${error.message}`);
  }
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body, url: String(url) };
}

function itemsFrom(api, body) {
  const items = api.kind === 'node' ? body.hits : body.items;
  assert.ok(Array.isArray(items), `${api.name} response must contain ${api.kind === 'node' ? 'hits' : 'items'}[]`);
  return items;
}

function normalizedSearch(api, body) {
  const items = itemsFrom(api, body);
  assert.ok(Number.isInteger(body.total), `${api.name} search response must contain integer total`);
  assert.ok(body.facets && Array.isArray(body.facets.genres) && Array.isArray(body.facets.years),
    `${api.name} search response must contain genre and year facets`);
  return {
    total: body.total,
    ids: items.map(item => String(item.tmdb_id ?? item.id)),
    items,
    genres: body.facets.genres.map(({ value, count }) => ({ value: String(value), count: Number(count) })).sort((a,b)=>a.value.localeCompare(b.value)),
    years: body.facets.years.map(({ value, count }) => ({ value: Number(value), count: Number(count) })).sort((a,b)=>a.value-b.value)
  };
}

function sameSearchResult(label, left, right) {
  assert.equal(left.total, right.total, `${label}: total differs (${left.total} vs ${right.total})`);
  assert.deepEqual(left.ids, right.ids, `${label}: ordered document IDs differ\nNode: ${JSON.stringify(left.ids)}\nRails: ${JSON.stringify(right.ids)}`);
  assert.deepEqual(left.genres, right.genres, `${label}: genre facets differ`);
  assert.deepEqual(left.years, right.years, `${label}: year facets differ`);
}

const searchableText = item => [
  item.title, item.original_title, item.short_description, item.overview, item.content,
  ...(Array.isArray(item.genres) ? item.genres : [])
].filter(Boolean).join(' ').toLowerCase();

function assertExpectedCase(testCase, normalized) {
  const ids = new Set(normalized.ids);
  for (const id of testCase.expectedAnyIds || []) {
    assert.ok(ids.has(String(id)), `${testCase.id}: expected document ID ${id} was not returned`);
  }
  for (const id of testCase.expectedNoneIds || []) {
    assert.ok(!ids.has(String(id)), `${testCase.id}: forbidden document ID ${id} was returned`);
  }

  if (testCase.id === 'plain-query-or') {
    assert.ok(ids.has('1001') && ids.has('1002'), 'plain-query-or: OR must return both space-only and adventure-only documents');
  }
  if (testCase.id === 'required-term') {
    for (const item of normalized.items) {
      assert.match(searchableText(item), /space/, `required-term: result ${item.id} does not contain required term "space"`);
    }
  }
  if (testCase.id === 'excluded-term') {
    for (const item of normalized.items) {
      assert.doesNotMatch(searchableText(item), /horror/, `excluded-term: result ${item.id} contains excluded term "horror"`);
    }
  }
  if (testCase.id === 'quoted-phrase-exclusion') {
    assert.ok(normalized.total > 0, 'quoted-phrase-exclusion: expected at least one positive Spider-Man result');
    for (const item of normalized.items) {
      assert.doesNotMatch(searchableText(item), /homecoming/, `quoted-phrase-exclusion: result ${item.id} contains excluded term "Homecoming"`);
      assert.match(searchableText(item), /spider[ -]man/, `quoted-phrase-exclusion: result ${item.id} has no Spider-Man phrase`);
    }
  }
  if (testCase.id === 'genre-filter') {
    for (const item of normalized.items) {
      assert.ok(Array.isArray(item.genres) && item.genres.includes('Science Fiction'),
        `genre-filter: result ${item.id} does not have the Science Fiction genre`);
    }
  }
  if (testCase.minimumRating !== undefined) {
    for (const item of normalized.items) {
      assert.ok(Number(item.vote_average) >= testCase.minimumRating,
        `minimum-rating: result ${item.id} has rating ${item.vote_average}`);
    }
  }
  if (testCase.id === 'browse') {
    for (let i = 1; i < normalized.items.length; i++) {
      const previous = normalized.items[i - 1];
      const current = normalized.items[i];
      const pPop = Number(previous.popularity ?? 0);
      const cPop = Number(current.popularity ?? 0);
      assert.ok(pPop > cPop || (pPop === cPop && String(previous.tmdb_id ?? previous.id) <= String(current.tmdb_id ?? current.id)),
        `browse: results ${previous.id} and ${current.id} violate popularity-descending / TMDB-ID tie-break ordering`);
    }
  }
  if (testCase.id === 'accent-folding') {
    assert.ok(normalized.items.some(item => searchableText(item).includes('amélie')),
      'accent-folding: expected the Amélie document to match "amelie"');
  }
}

function normalizeSuggestions(api, body) {
  assert.ok(Array.isArray(body.suggestions), `${api.name} suggestion response must contain suggestions[]`);
  return body.suggestions.map(item => ({
    id: String(item.id ?? ''),
    text: String(item.text ?? item.title ?? '')
  }));
}

async function runSearchCase(testCase, nodeApi, railsApi) {
  const paramsFor = api => ({
    q: testCase.q,
    genres: testCase.genres,
    [api.kind === 'node' ? 'minRating' : 'min_rating']: testCase.minRating,
    from: 0,
    size: pageSize
  });
  const [nodeResponse, railsResponse] = await Promise.all([
    callApi(nodeApi, 'search', paramsFor(nodeApi)),
    callApi(railsApi, 'search', paramsFor(railsApi))
  ]);
  assert.equal(nodeResponse.status, 200, `${testCase.id}: Node returned ${nodeResponse.status}: ${JSON.stringify(nodeResponse.body)}`);
  assert.equal(railsResponse.status, 200, `${testCase.id}: Rails returned ${railsResponse.status}: ${JSON.stringify(railsResponse.body)}`);
  const node = normalizedSearch(nodeApi, nodeResponse.body);
  const rails = normalizedSearch(railsApi, railsResponse.body);
  assertExpectedCase(testCase, node);
  assertExpectedCase(testCase, rails);
  sameSearchResult(testCase.id, node, rails);
  console.log(`✓ ${testCase.id}: total=${node.total}, IDs and facets match`);
}

async function runSuggestionCase(testCase, nodeApi, railsApi) {
  const [nodeResponse, railsResponse] = await Promise.all([
    callApi(nodeApi, 'suggest', { q: testCase.suggest, size: 10 }),
    callApi(railsApi, 'suggest', { q: testCase.suggest, size: 10 })
  ]);
  assert.equal(nodeResponse.status, 200, `${testCase.id}: Node returned ${nodeResponse.status}: ${JSON.stringify(nodeResponse.body)}`);
  assert.equal(railsResponse.status, 200, `${testCase.id}: Rails returned ${railsResponse.status}: ${JSON.stringify(railsResponse.body)}`);
  const node = normalizeSuggestions(nodeApi, nodeResponse.body);
  const rails = normalizeSuggestions(railsApi, railsResponse.body);
  for (const [name, suggestions] of [['Node', node], ['Rails', rails]]) {
    assert.ok(suggestions.length <= 10, `${testCase.id}: ${name} returned more than 10 suggestions`);
    const texts = suggestions.map(item => item.text.toLowerCase());
    assert.equal(new Set(texts).size, texts.length, `${testCase.id}: ${name} returned duplicate suggestion text`);
    for (const text of testCase.expectedSuggestionAnyTexts || []) {
      assert.ok(suggestions.some(item => item.text.toLowerCase() === text.toLowerCase()),
        `${testCase.id}: ${name} did not suggest "${text}"`);
    }
  }
  assert.deepEqual(node, rails, `${testCase.id}: suggestion IDs/text/order differ\nNode: ${JSON.stringify(node)}\nRails: ${JSON.stringify(rails)}`);
  console.log(`✓ ${testCase.id}: ${node.length} suggestions match`);
}

async function runMalformedCase(testCase, nodeApi, railsApi) {
  const params = { q: testCase.q, from: 0, size: pageSize };
  const [nodeResponse, railsResponse] = await Promise.all([
    callApi(nodeApi, 'search', params),
    callApi(railsApi, 'search', params)
  ]);
  assert.equal(nodeResponse.status, testCase.expectedStatus,
    `${testCase.id}: Node status ${nodeResponse.status}; expected ${testCase.expectedStatus}: ${JSON.stringify(nodeResponse.body)}`);
  assert.equal(railsResponse.status, testCase.expectedStatus,
    `${testCase.id}: Rails status ${railsResponse.status}; expected ${testCase.expectedStatus}: ${JSON.stringify(railsResponse.body)}`);
  const node = normalizedSearch(nodeApi, nodeResponse.body);
  const rails = normalizedSearch(railsApi, railsResponse.body);
  sameSearchResult(testCase.id, node, rails);
  console.log(`✓ ${testCase.id}: incomplete query handled with HTTP ${testCase.expectedStatus}`);
}

const nodeApi = { name:'Node', kind:'node', base:nodeBase };
const railsApi = { name:'Rails', kind:'rails', base:railsBase };

console.log(`Contract index: ${index} at ${esBase}; Node API: ${nodeBase}; Rails API: ${railsBase}`);
if (setupIndex) await seedContractIndex();

for (const testCase of contract.cases) {
  if (testCase.suggest !== undefined) await runSuggestionCase(testCase, nodeApi, railsApi);
  else await runSearchCase(testCase, nodeApi, railsApi);
}
for (const testCase of contract.malformedQueries || []) await runMalformedCase(testCase, nodeApi, railsApi);

console.log(`All ${contract.cases.length + (contract.malformedQueries || []).length} shared contract cases passed.`);
