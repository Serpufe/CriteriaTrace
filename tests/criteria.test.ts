import { describe, expect, it } from 'vitest';
import { markdownSource, parseCriteria } from '../src/criteria.js';

describe('criteria parsing', () => {
  it('keeps labeled and acceptance-section criteria explicit', () => {
    const source = markdownSource(
      'task.md',
      `# Task\n\n## Acceptance criteria\n- UTF-8 names survive export.\nAC-7: a failed write is reported.\n`,
    );
    expect(parseCriteria(source)).toEqual([
      {
        id: 'AC-1',
        text: 'UTF-8 names survive export.',
        origin: 'explicit',
        sourceId: 'local-spec',
      },
      {
        id: 'AC-7',
        text: 'a failed write is reported.',
        origin: 'explicit',
        sourceId: 'local-spec',
      },
    ]);
  });

  it('preserves requirement bullets below nested headings', () => {
    const criteria = parseCriteria(
      markdownSource(
        'task.md',
        `## Requirements\n### Error behavior\n- report a useful error\n## Notes\n- not a criterion\n`,
      ),
    );
    expect(criteria.map((item) => item.text)).toEqual(['report a useful error']);
  });

  it('keeps unstructured task text intact until semantic decomposition is available', () => {
    const source = markdownSource(
      'task.md',
      '# Objective\n\nPreserve file names. Report invalid archives.',
    );
    const [criterion] = parseCriteria(source);
    expect(criterion?.origin).toBe('explicit');
    expect(criterion?.text).toContain('Report invalid archives');
    expect(criterion?.id).toMatch(/^REQ-/);
  });

  it('marks not-applicable only when the source uses the explicit N/A marker', () => {
    const [criterion] = parseCriteria(
      markdownSource(
        'task.md',
        '## Acceptance criteria\n- AC-4: [N/A] This deployment has no archive export.',
      ),
    );
    expect(criterion?.notApplicable).toBe(true);
    expect(criterion?.text).toBe('This deployment has no archive export.');
  });

  it('rejects an oversized criterion ID before constructing evidence expressions', () => {
    expect(() => parseCriteria(markdownSource('task.md', `AC-${'1'.repeat(62)}: example`))).toThrow(
      'Criterion ID exceeds',
    );
  });

  it('bounds the number of criteria in a single source', () => {
    const text = Array.from({ length: 501 }, (_, index) => `AC-${index + 1}: example`).join('\n');
    expect(() => parseCriteria(markdownSource('task.md', text))).toThrow('Too many criteria');
  });
});
