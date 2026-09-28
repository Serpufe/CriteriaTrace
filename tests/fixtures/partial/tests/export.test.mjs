import assert from 'node:assert/strict';
import test from 'node:test';
import { exportFilename } from '../src/export.js';

test('export filename returns the same name', () => {
  assert.equal(exportFilename('file.txt'), 'file.txt');
});
