import { describe, expect, it } from 'vitest';
import { toJson, toMarkdown } from '../src/report.js';
import type { TraceReport } from '../src/types.js';

describe('report formats', () => {
  it('emits versioned JSON and safely displays untrusted Markdown content', () => {
    const report: TraceReport = {
      schemaVersion: 1,
      tool: { name: 'CriteriaTrace', version: '0.1.0' },
      repository: { root: '/tmp/repo' },
      base: 'base-sha',
      head: 'head-sha',
      createdAt: '2026-01-01T00:00:00.000Z',
      sources: [
        {
          id: 'src',
          kind: 'inline',
          title: 'PR <script> ![view](https://attacker.example/tracker)',
          text: 'OPENAI_API_KEY=report-secret-value',
        },
      ],
      criteria: [
        {
          id: 'AC-1',
          text: 'Handle <img>| input ![click](https://attacker.example/)',
          origin: 'explicit',
          sourceId: 'src',
          status: 'PARTIAL',
          implementationEvidence: [],
          testEvidence: [],
          executions: [],
          reason: 'Candidate only.',
        },
      ],
      executions: [
        {
          id: 'head-test',
          revision: 'abc',
          command: ['node', 'script`|![command](https://attacker.example/)'],
          exitCode: 0,
          signal: null,
          timedOut: false,
          outputTruncated: false,
          durationMs: 1,
          output: '````\n<img src=x>',
          workspace: 'temporary',
        },
      ],
      generatedTests: [
        {
          criterionId: 'AC-1',
          fileName: '__criteriatrace__/test_ac-1.test.mjs',
          source: 'const dangerous = "```";',
          rationale: 'Generated.',
          executions: ['head-generated-test'],
        },
      ],
      summary: { VERIFIED: 0, PARTIAL: 1, UNVERIFIED: 0, MISSING: 0, NOT_APPLICABLE: 0 },
      limitations: [],
    };
    expect(JSON.parse(toJson(report)).schemaVersion).toBe(1);
    expect(toJson(report)).not.toContain('report-secret-value');
    const markdown = toMarkdown(report);
    expect(markdown).toContain('&lt;img&gt;\\| input');
    expect(markdown).toContain('&lt;script&gt;');
    expect(markdown).not.toContain('![click]');
    expect(markdown).not.toContain('![view]');
    expect(markdown).toContain('``node script`\\|![command](https://attacker.example/)``');
    expect(markdown).not.toContain('report-secret-value');
    expect(markdown).toContain('`````text');
    expect(markdown).toContain('````\nconst dangerous');
  });
});
