import assert from 'node:assert/strict';
import test from 'node:test';
import { exportFilename } from '../src/export.js';

// AC-1: this executable test covers UTF-8 filename preservation.
test('AC-1 preserves UTF-8 filename', () => {
  assert.equal(exportFilename('café.zip'), 'café.zip');
});
