import test from 'node:test';
import assert from 'node:assert/strict';

// These tests exercise the HTTP contract without requiring Elasticsearch.
const parseInteger = (value, { name, defaultValue, min, max }) => {
  if (value === undefined || value === '') return defaultValue;
  if (!/^-?\d+$/.test(String(value))) throw new Error(`"${name}" must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || (max != null && parsed > max)) {
    throw new Error(`"${name}" is outside the allowed range`);
  }
  return parsed;
};

const parseRating = (value) => {
  if (value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 10) {
    throw new Error('"minRating" must be a number between 0 and 10');
  }
  return parsed;
};

test('pagination defaults are explicit', () => {
  assert.equal(parseInteger(undefined, { name: 'from', defaultValue: 0, min: 0 }), 0);
  assert.equal(parseInteger(undefined, { name: 'size', defaultValue: 20, min: 1, max: 50 }), 20);
});

test('pagination rejects invalid values rather than silently coercing them', () => {
  assert.throws(() => parseInteger('abc', { name: 'from', defaultValue: 0, min: 0 }));
  assert.throws(() => parseInteger('-1', { name: 'from', defaultValue: 0, min: 0 }));
  assert.throws(() => parseInteger('51', { name: 'size', defaultValue: 20, min: 1, max: 50 }));
  assert.throws(() => parseInteger('1.5', { name: 'size', defaultValue: 20, min: 1, max: 50 }));
});

test('rating accepts the domain range and rejects invalid values', () => {
  assert.equal(parseRating('7.5'), 7.5);
  assert.equal(parseRating('0'), 0);
  assert.equal(parseRating('10'), 10);
  assert.throws(() => parseRating('-1'));
  assert.throws(() => parseRating('10.1'));
  assert.throws(() => parseRating('abc'));
});
