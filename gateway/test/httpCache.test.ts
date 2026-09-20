import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetHttpCacheForTests, httpCacheGet, httpCacheSet, httpCacheSize } from '../src/core/httpCache.js';

beforeEach(() => resetHttpCacheForTests());

test('Set/Get-Hit innerhalb TTL', () => {
  httpCacheSet('u', { a: 1 }, 60_000, 1_000);
  assert.deepEqual(httpCacheGet('u', 2_000), { a: 1 });
});

test('Get nach TTL-Ablauf = null (Entry wird entfernt)', () => {
  httpCacheSet('u', { a: 1 }, 60_000, 1_000);
  assert.equal(httpCacheGet('u', 62_000), null);
  assert.equal(httpCacheSize(), 0);
});

test('Get auf Unbekanntes = null', () => {
  assert.equal(httpCacheGet('nope', 1), null);
});

test('Prune: abgelaufene Eintraege werden beim Setzen entfernt', () => {
  // 32 Sets triggern den Prune-Zyklus.
  for (let i = 0; i < 32; i++) httpCacheSet(`u${i}`, i, 10, 1_000);
  httpCacheSet('fresh', 'x', 60_000, 2_000);
  assert.equal(httpCacheGet('u0', 2_000), null);
  assert.equal(httpCacheGet('fresh', 2_000), 'x');
});

test('Hart-Deckel 200: aelteste fliegen', () => {
  for (let i = 0; i < 224; i++) httpCacheSet(`u${i}`, i, 60_000, 1_000 + i);
  // Prune-Zyklus alle 32 Sets: bis hierhin wurde mindestens einmal geprunt,
  // der Deckel haelt danach exakt.
  assert.ok(httpCacheSize() <= 200, `size=${httpCacheSize()}`);
  assert.equal(httpCacheGet('u0', 2_000), null);
  assert.deepEqual(httpCacheGet('u223', 2_000), 223);
});
