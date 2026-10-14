import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readConfig } from '../dist/config.js';

test('configuration has safe defaults', () => {
  assert.deepEqual(readConfig({}), { port: 3000, maxUploadBytes: 25_000_000, conversionTimeoutMs: 60_000, maxConcurrentConversions: 2 });
});
test('configuration accepts a custom port and lower resource limits', () => {
  assert.deepEqual(readConfig({ PORT: '4321', MAX_UPLOAD_BYTES: '1024', CONVERSION_TIMEOUT_MS: '1000', MAX_CONCURRENT_CONVERSIONS: '1' }), { port: 4321, maxUploadBytes: 1024, conversionTimeoutMs: 1000, maxConcurrentConversions: 1 });
});
test('configuration rejects invalid numbers and limits above the safety ceilings', () => {
  for (const env of [{ PORT: '0' }, { PORT: '65536' }, { PORT: '3000abc' }, { PORT: '' }, { CONVERSION_TIMEOUT_MS: '60001' }, { MAX_UPLOAD_BYTES: '25000001' }, { MAX_CONCURRENT_CONVERSIONS: '-1' }]) assert.throws(() => readConfig(env));
});
