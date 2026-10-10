export const isElasticsearchBadRequest = error => error?.meta?.statusCode === 400;

export const emptySearchResponse = () => ({
  total: 0,
  took_ms: 0,
  hits: [],
  facets: { genres: [], years: [] }
});
