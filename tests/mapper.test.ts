import { describe, expect, it } from 'vitest';
import {
  hasExplicitCriterionReference,
  isSourcePath,
  isTestPath,
  overlapScore,
  validateModelPaths,
} from '../src/mapper.js';

describe('deterministic path and candidate helpers', () => {
  it('recognizes common Vitest, Jest, and pytest test paths', () => {
    expect(isTestPath('src/export.test.ts')).toBe(true);
    expect(isTestPath('__tests__/export.spec.js')).toBe(true);
    expect(isTestPath('tests/test_export.py')).toBe(true);
    expect(isTestPath('tests/export.js')).toBe(true);
    expect(isTestPath('tests/fixtures/regression/task.md')).toBe(false);
    expect(isTestPath('tests/fixtures/regression/tests/export.test.mjs')).toBe(false);
    expect(isTestPath('tests/helpers.ts')).toBe(false);
    expect(isSourcePath('tests/helpers.ts')).toBe(false);
    expect(isTestPath('tests/README.md')).toBe(false);
    expect(isSourcePath('src/export.ts')).toBe(true);
  });

  it('marks explicit IDs only in candidate paths, implementation comments, or test names', () => {
    expect(
      hasExplicitCriterionReference('src/cli.ts', "const demo = 'AC-1';", 'AC-1', 'implementation'),
    ).toBe(false);
    expect(
      hasExplicitCriterionReference(
        'src/export.ts',
        '// AC-1: preserve names',
        'AC-1',
        'implementation',
      ),
    ).toBe(true);
    expect(
      hasExplicitCriterionReference(
        'tests/export.test.ts',
        "test('AC-1 preserves names', fn);",
        'AC-1',
        'test',
      ),
    ).toBe(true);
    expect(
      hasExplicitCriterionReference(
        'tests/verify.test.ts',
        "const fixture = '- AC-1: preserve names';",
        'AC-1',
        'test',
      ),
    ).toBe(false);
  });

  it('scores token overlap without calling it confidence', () => {
    expect(
      overlapScore('UTF-8 filename survives export', 'src/exportFilename.js UTF-8 filename'),
    ).toBeGreaterThan(0.3);
    expect(overlapScore('database migration checksum', 'payment button color')).toBe(0);
  });

  it('accepts only model paths already present in the allowlist', () => {
    expect(
      validateModelPaths(['src/a.ts', '../secret', 'src/a.ts'], new Set(['src/a.ts'])),
    ).toEqual(['src/a.ts']);
  });
});
