import { Client } from '@elastic/elasticsearch';
import { getDefaultOperator } from './querySemantics.js';

const ES_URL = process.env.ES_URL || 'http://localhost:9200';
const INDEX = process.env.INDEX || 'movies';

export const es = new Client({ node: ES_URL });

export const search = async ({ q = '', genres = [], minRating = null, from = 0, size = 20 }) => {
  // Preserve OR semantics for broad recall on ordinary terms. When the user
  // explicitly excludes a term, use AND so the positive clause stays mandatory.
  const must = q
    ? [{
        simple_query_string: {
          query: q,
          fields: ['title^3', 'short_description^2', 'overview^2', 'content^1'],
          default_operator: getDefaultOperator(q),
          lenient: true
        }
      }]
    : [{ match_all: {} }];

  // Phrase match is a ranking boost, not an additional required condition.
  const should = q
    ? [{
        multi_match: {
          query: q,
          type: 'phrase',
          fields: ['title^3', 'short_description^2', 'overview^2'],
          slop: 1,
          boost: 2
        }
      }]
    : [];

  const filter = [];
  if (genres.length) filter.push({ terms: { genres } });
  if (minRating != null) filter.push({ range: { vote_average: { gte: minRating } } });

  // tmdb_id is a mapped keyword and a stable tie-breaker for repeatable pagination.
  const sort = q
    ? [{ _score: 'desc' }, { popularity: 'desc' }, { tmdb_id: 'asc' }]
    : [{ popularity: 'desc' }, { tmdb_id: 'asc' }];

  const resp = await es.search({
    index: INDEX,
    from,
    size,
    track_total_hits: true,
    query: { bool: { must, should, filter } },
    sort,
    highlight: {
      pre_tags: ['<mark>'],
      post_tags: ['</mark>'],
      fields: {
        title: { number_of_fragments: 0 },
        short_description: { fragment_size: 150, number_of_fragments: 2 },
        overview: { fragment_size: 150, number_of_fragments: 2 }
      }
    },
    aggs: {
      by_genre: { terms: { field: 'genres', size: 15 } },
      by_year: { histogram: { field: 'year', interval: 5, min_doc_count: 1 } }
    }
  });

  return {
    total: typeof resp.hits.total === 'number' ? resp.hits.total : resp.hits.total.value,
    took_ms: resp.took,
    hits: resp.hits.hits.map(h => ({
      id: h._id,
      score: h._score,
      ...h._source,
      highlight: h.highlight || {}
    })),
    facets: {
      genres: resp.aggregations.by_genre.buckets.map(b => ({ value: b.key, count: b.doc_count })),
      years: resp.aggregations.by_year.buckets.map(b => ({ value: b.key, count: b.doc_count }))
    }
  };
};

export const suggest = async ({ q, size = 5 }) => {
  if (!q) return { suggestions: [] };
  const resp = await es.search({
    index: INDEX,
    size: 0,
    suggest: {
      title_suggest: {
        prefix: q,
        completion: { field: 'title.suggest', size, skip_duplicates: true, fuzzy: { fuzziness: 'AUTO' } }
      }
    }
  });
  const options = resp.suggest.title_suggest[0]?.options || [];
  return {
    suggestions: options.map(o => ({
      text: o.text,
      id: o._id,
      title: o._source?.title,
      year: o._source?.year,
      poster_url: o._source?.poster_url
    }))
  };
};

export const getById = async (id) => {
  try {
    const resp = await es.get({ index: INDEX, id });
    return { id: resp._id, ...resp._source };
  } catch (e) {
    if (e.meta?.statusCode === 404) return null;
    throw e;
  }
};
