import test from 'node:test';
import assert from 'node:assert/strict';
import { queryScalar, parseInteger, parseRating } from '../validation.js';
import { getDefaultOperator } from '../querySemantics.js';

test('pagination defaults are explicit', () => {
  assert.equal(parseInteger(undefined, { name: 'from', defaultValue: 0, min: 0 }), 0);
  assert.equal(parseInteger(undefined, { name: 'size', defaultValue: 20, min: 1, max: 50 }), 20);
});

test('pagination rejects invalid values rather than silently coercing them', () => {
  assert.throws(() => parseInteger('abc', { name: 'from', defaultValue: 0, min: 0 }), { status: 400 });
  assert.throws(() => parseInteger('-1', { name: 'from', defaultValue: 0, min: 0 }), { status: 400 });
  assert.throws(() => parseInteger('51', { name: 'size', defaultValue: 20, min: 1, max: 50 }), { status: 400 });
  assert.throws(() => parseInteger('1.5', { name: 'size', defaultValue: 20, min: 1, max: 50 }), { status: 400 });
});

test('rating accepts the domain range and rejects invalid values', () => {
  assert.equal(parseRating('7.5'), 7.5);
  assert.equal(parseRating('0'), 0);
  assert.equal(parseRating('10'), 10);
  assert.equal(parseRating(undefined), null);
  assert.throws(() => parseRating('-1'), { status: 400 });
  assert.throws(() => parseRating('10.1'), { status: 400 });
  assert.throws(() => parseRating('abc'), { status: 400 });
});

test('query parameters must be scalar values', () => {
  assert.equal(queryScalar('hello', 'q'), 'hello');
  assert.equal(queryScalar(undefined, 'q'), undefined);
  assert.throws(() => queryScalar(['a', 'b'], 'q'), { status: 400 });
  assert.throws(() => queryScalar({ nested: 'value' }, 'q'), { status: 400 });
});

test('ordinary queries retain OR semantics', () => {
  assert.equal(getDefaultOperator('Spider-Man'), 'OR');
  assert.equal(getDefaultOperator('"Spider-Man"'), 'OR');
});

test('a query with an exclusion uses AND so the positive clause remains mandatory', () => {
  assert.equal(getDefaultOperator('"Spider-Man" -Homecoming'), 'AND');
  assert.equal(getDefaultOperator('Spider-Man -Homecoming'), 'AND');
  assert.equal(getDefaultOperator('"Spider-Man" -Homecoming Action'), 'AND');
});
