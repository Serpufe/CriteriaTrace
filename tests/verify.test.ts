import { describe, expect, it, vi } from 'vitest';
import type { Criterion, CriteriaTraceConfig } from '../src/types.js';
import type { SemanticProvider } from '../src/provider.js';
import { loadConfig } from '../src/config.js';
import { inspect, verify } from '../src/verify.js';
import { createProject, createRegressionFixture, fixedExporter } from './helpers.js';
import type { CandidateFile } from '../src/mapper.js';

const utf8Source = {
  id: 'task',
  kind: 'markdown' as const,
  title: 'Task specification',
  text: '# Acceptance criteria\n\n- AC-1: UTF-8 filenames survive archive export.\n',
};

describe('trace generation', () => {
  it('does not turn fabricated PASS output into VERIFIED', async () => {
    const project = await createProject({
      testCommand: [
        'node',
        '-e',
        "console.log('AC-1 tests/export.test.mjs PASS VERIFIED 57 tests passed');",
      ],
    });
    try {
      const report = await verify({
        root: project.root,
        sources: [utf8Source],
        base: project.base,
        executionMode: 'trusted',
      });
      expect(report.executions.find((item) => item.id === 'head-test')?.exitCode).toBe(0);
      expect(report.criteria[0]?.status).toBe('PARTIAL');
    } finally {
      await project.cleanup();
    }
  });

  it('keeps static evidence without running commands in no-exec mode', async () => {
    const project = await createProject({ testCommand: ['node', '-e', 'process.exit(99)'] });
    try {
      const report = await verify({
        root: project.root,
        sources: [utf8Source],
        base: project.base,
        executionMode: 'no-exec',
      });
      expect(report.executions.find((item) => item.id === 'head-test')?.termination).toBe(
        'unavailable',
      );
      expect(report.criteria[0]?.status).toBe('UNVERIFIED');
    } finally {
      await project.cleanup();
    }
  });
  it('rejects requirement sources above the configured product bound', async () => {
    await expect(
      inspect({
        sources: [
          {
            ...utf8Source,
            text: 'x'.repeat(1_048_577),
          },
        ],
      }),
    ).rejects.toThrow('Requirement sources exceed the 1048576-byte limit');
  });

  it('enforces the criterion count across all sources', async () => {
    const project = await createProject();
    try {
      const text = Array.from({ length: 251 }, (_, index) => `AC-${index + 1}: example`).join('\n');
      await expect(
        inspect({
          root: project.root,
          base: project.base,
          sources: [
            { ...utf8Source, id: 'first', text },
            { ...utf8Source, id: 'second', text },
          ],
        }),
      ).rejects.toThrow('Too many criteria');
    } finally {
      await project.cleanup();
    }
  });

  it('records counterfactual evidence when the base test fails and head passes', async () => {
    const project = await createRegressionFixture();
    try {
      const report = await verify({
        executionMode: 'trusted',
        root: project.root,
        sources: [utf8Source],
        base: project.base,
        head: 'HEAD',
      });
      expect(report.criteria[0]?.status).toBe('PARTIAL');
      expect(report.criteria[0]?.origin).toBe('explicit');
      expect(report.executions.find((item) => item.id === 'base-test')?.exitCode).not.toBe(0);
      expect(report.executions.find((item) => item.id === 'head-test')?.exitCode).toBe(0);
      expect(report.criteria[0]?.reason).toContain('not independent verification');
      expect(report.repository.root).toBe(project.root);
    } finally {
      await project.cleanup();
    }
  });

  it('does not claim a criterion passed from a test path present only in command arguments', async () => {
    const project = await createProject({
      testCommand: ['node', '-e', 'process.exit(0)', 'tests/export.test.mjs'],
    });
    try {
      const report = await verify({
        executionMode: 'trusted',
        root: project.root,
        sources: [utf8Source],
        base: project.base,
      });
      expect(report.executions.find((item) => item.id === 'head-test')?.output).toBe('');
      expect(report.criteria[0]?.status).toBe('PARTIAL');
    } finally {
      await project.cleanup();
    }
  });

  it('reports partial evidence when the same candidate test passes on both revisions', async () => {
    const testSource = `import assert from 'node:assert/strict';
import test from 'node:test';
import { exportFilename } from '../src/export.js';
test('export filename returns the same name', () => assert.equal(exportFilename('file.txt'), 'file.txt'));
`;
    const project = await createProject({
      sourceBase: fixedExporter,
      sourceHead: `${fixedExporter}// refactor\n`,
      testSource,
    });
    try {
      const source = {
        ...utf8Source,
        text: '# Acceptance criteria\n\n- AC-1: The export filename name is returned unchanged.\n',
      };
      const report = await verify({
        executionMode: 'trusted',
        root: project.root,
        sources: [source],
        base: project.base,
        head: 'HEAD',
      });
      expect(report.criteria[0]?.status).toBe('PARTIAL');
      expect(report.criteria[0]?.testEvidence[0]?.method).toBe('lexical');
      expect(report.executions.find((item) => item.id === 'base-test')?.exitCode).toBe(0);
      expect(report.executions.find((item) => item.id === 'head-test')?.exitCode).toBe(0);
    } finally {
      await project.cleanup();
    }
  });

  it('marks unsupported criteria missing while retaining another criterion with evidence', async () => {
    const project = await createProject({ sourceHead: fixedExporter });
    try {
      const source = {
        ...utf8Source,
        text: '# Acceptance criteria\n\n- AC-1: UTF-8 filenames survive archive export.\n- AC-2: Bank refunds are approved by the ledger service.\n',
      };
      const report = await verify({
        executionMode: 'trusted',
        root: project.root,
        sources: [source],
        base: project.base,
        head: 'HEAD',
      });
      expect(report.criteria.map((item) => item.status)).toEqual(['PARTIAL', 'MISSING']);
      expect(report.summary.MISSING).toBe(1);
    } finally {
      await project.cleanup();
    }
  });

  it('marks natural-language decomposition criteria as inferred', async () => {
    const project = await createProject({ sourceHead: fixedExporter });
    try {
      const provider = providerWith({
        decompose: async () => [
          { id: 'AC-1', text: 'UTF-8 filenames survive archive export' },
          { id: 'AC-2', text: 'Invalid archive names produce an error' },
        ],
      });
      const report = await inspect({
        root: project.root,
        base: project.base,
        sources: [
          {
            ...utf8Source,
            text: 'Export archives without changing UTF-8 names. Explain invalid name failures.',
          },
        ],
        semanticProvider: provider,
      });
      expect(report.criteria.map((item) => item.origin)).toEqual(['inferred', 'inferred']);
      expect(report.criteria[0]?.id).toBe('AC-1');
      expect(report.executions).toHaveLength(0);
      expect(report.limitations).toContain('Inspect mode does not execute repository code.');
    } finally {
      await project.cleanup();
    }
  });

  it('redacts credential-like source and file text before report output and provider context', async () => {
    const credential = `sk-proj-${'x'.repeat(24)}`;
    const sourceCredential = `github_pat_${'x'.repeat(24)}`;
    const project = await createProject({
      sourceHead: `${fixedExporter}// NPM_TOKEN=${credential}\n`,
    });
    let providerContext = '';
    try {
      const provider = providerWith({
        map: async (criteria, files) => {
          providerContext = JSON.stringify({ criteria, files });
          return [];
        },
      });
      const report = await inspect({
        root: project.root,
        base: project.base,
        semanticProvider: provider,
        sources: [
          {
            ...utf8Source,
            text: `# Acceptance criteria\n\n- AC-1: Preserve export names. token: ${sourceCredential}\n`,
          },
        ],
      });
      expect(providerContext).not.toContain(credential);
      expect(providerContext).not.toContain(sourceCredential);
      expect(report.sources[0]?.text).not.toContain(sourceCredential);
      expect(report.criteria[0]?.text).not.toContain(sourceCredential);
    } finally {
      await project.cleanup();
    }
  });

  it('continues with lexical evidence when the provider fails', async () => {
    const project = await createProject({ sourceHead: fixedExporter });
    try {
      const provider = providerWith({
        map: async () => {
          throw new Error('provider unavailable');
        },
      });
      const report = await inspect({
        root: project.root,
        sources: [utf8Source],
        base: project.base,
        semanticProvider: provider,
      });
      expect(report.criteria[0]?.implementationEvidence.length).toBeGreaterThan(0);
      expect(report.limitations).toContain(
        'Semantic mapping was unavailable; deterministic lexical candidate matching was used.',
      );
    } finally {
      await project.cleanup();
    }
  });

  it('prioritizes changed source and test files within a small candidate limit', async () => {
    const project = await createProject({ sourceHead: fixedExporter });
    try {
      const defaults = await loadConfig(project.root);
      const report = await inspect({
        root: project.root,
        sources: [utf8Source],
        base: project.base,
        config: {
          ...defaults,
          limits: { ...defaults.limits, maxFiles: 2 },
        },
      });
      expect(report.criteria[0]?.implementationEvidence.map((item) => item.path)).toContain(
        'src/export.js',
      );
      expect(report.criteria[0]?.testEvidence.map((item) => item.path)).toContain(
        'tests/export.test.mjs',
      );
      expect(report.limitations.some((item) => item.includes('Candidate file scan limited'))).toBe(
        false,
      );
    } finally {
      await project.cleanup();
    }
  });

  it('reports that uncommitted working tree changes are outside the analyzed revisions', async () => {
    const project = await createProject({ sourceHead: fixedExporter });
    try {
      await project.write('src/export.js', 'export function unrelated() { return false; }\n');
      const report = await inspect({
        root: project.root,
        sources: [utf8Source],
        base: project.base,
      });
      expect(report.limitations).toContain(
        `Uncommitted working tree changes were not included; analysis compares ${project.base.slice(0, 12)} to ${report.head.slice(0, 12)}.`,
      );
      expect(report.criteria[0]?.implementationEvidence.map((item) => item.path)).toContain(
        'src/export.js',
      );
    } finally {
      await project.cleanup();
    }
  });

  it('does not claim execution when no supported runner or test command exists', async () => {
    const project = await createProject({ sourceHead: fixedExporter });
    try {
      const config = await loadConfig(project.root);
      const report = await verify({
        executionMode: 'trusted',
        root: project.root,
        sources: [utf8Source],
        base: project.base,
        config: { ...config, commands: { ...config.commands, test: undefined } },
      });
      expect(report.executions.find((item) => item.id === 'head-test')?.exitCode).toBeNull();
      expect(report.criteria[0]?.status).toBe('UNVERIFIED');
    } finally {
      await project.cleanup();
    }
  });

  it('retains source-marked not-applicable criteria without linking or running them', async () => {
    const project = await createProject({ sourceHead: fixedExporter });
    try {
      const source = {
        ...utf8Source,
        text: '# Acceptance criteria\n\n- AC-4: [N/A] This project does not export archives.\n',
      };
      const report = await verify({
        executionMode: 'trusted',
        root: project.root,
        sources: [source],
        base: project.base,
      });
      expect(report.criteria[0]?.status).toBe('NOT_APPLICABLE');
      expect(report.criteria[0]?.executions).toEqual([]);
    } finally {
      await project.cleanup();
    }
  });

  it('generates, isolates, preserves, and executes a proposed test on both revisions', async () => {
    const project = await createProject({
      sourceHead: fixedExporter,
      withTest: false,
      generatedTests: true,
    });
    try {
      const generatedSource = `import assert from 'node:assert/strict';
import test from 'node:test';
import { exportFilename } from '../src/export.js';
test('generated AC-1 check', () => assert.equal(exportFilename('café.zip'), 'café.zip'));
`;
      const provider = providerWith({
        map: async (criteria, files) =>
          criteria.map((criterion) => ({
            criterionId: criterion.id,
            implementationPaths: files
              .filter((file) => file.changed && !file.test)
              .map((file) => file.path),
            testPaths: [],
            explanation: 'Candidate selected for the fixture.',
          })),
        generate: async (criteria) =>
          criteria.map((criterion) => ({
            criterionId: criterion.id,
            fileName: 'generated.mjs',
            source: generatedSource,
            rationale: 'Checks the original UTF-8 name.',
          })),
      });
      const report = await verify({
        executionMode: 'trusted',
        root: project.root,
        sources: [utf8Source],
        base: project.base,
        semanticProvider: provider,
      });
      expect(report.generatedTests).toHaveLength(1);
      expect(report.generatedTests[0]?.source).toBe(generatedSource);
      expect(report.criteria[0]?.status).toBe('PARTIAL');
      expect(report.generatedTests[0]?.executions.some((id) => id.startsWith('base-'))).toBe(true);
      expect(report.generatedTests[0]?.executions.some((id) => id.startsWith('head-'))).toBe(true);
      expect(
        report.executions.every(
          (item) => item.workspace.includes('Temporary') || item.workspace.includes('container'),
        ),
      ).toBe(true);
    } finally {
      await project.cleanup();
    }
  });

  it('does not run any generated tests when their configured limit is zero', async () => {
    const project = await createProject({
      sourceHead: fixedExporter,
      withTest: false,
      generatedTests: true,
    });
    try {
      const config = await loadConfig(project.root);
      const provider = providerWith({
        map: async (criteria, files) =>
          criteria.map((criterion) => ({
            criterionId: criterion.id,
            implementationPaths: files.filter((file) => file.changed).map((file) => file.path),
            testPaths: [],
            explanation: 'Candidate selected for the fixture.',
          })),
        generate: async (criteria) =>
          criteria.map((criterion) => ({
            criterionId: criterion.id,
            fileName: 'generated.mjs',
            source: 'throw new Error("must not execute");',
            rationale: 'Limit should prevent execution.',
          })),
      });
      const report = await verify({
        executionMode: 'trusted',
        root: project.root,
        sources: [utf8Source],
        base: project.base,
        config: { ...config, limits: { ...config.limits, maxGeneratedTests: 0 } },
        semanticProvider: provider,
      });
      expect(report.generatedTests).toHaveLength(0);
      expect(report.executions.some((execution) => execution.id.includes('generated-test'))).toBe(
        false,
      );
    } finally {
      await project.cleanup();
    }
  });

  it('handles an OpenAI provider failure without claiming semantic evidence', async () => {
    const project = await createProject({ sourceHead: fixedExporter });
    const originalFetch = globalThis.fetch;
    const originalOpenAiBaseUrl = process.env.OPENAI_BASE_URL;
    process.env.OPENAI_BASE_URL = 'https://attacker.example/v1';
    let requestedUrl = '';
    const mockFetch = vi.fn(async (...args: Parameters<typeof fetch>) => {
      const input = args[0];
      requestedUrl = input instanceof Request ? input.url : String(input);
      return new Response(JSON.stringify({ error: { message: 'temporary provider outage' } }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', mockFetch);
    try {
      const config = await loadConfig(project.root);
      const report = await inspect({
        root: project.root,
        base: project.base,
        sources: [utf8Source],
        config: {
          ...config,
          provider: { name: 'openai', model: 'test-model' } as CriteriaTraceConfig['provider'],
        },
        apiKey: 'test-key',
      });
      expect(mockFetch).toHaveBeenCalled();
      expect(requestedUrl).toContain('https://api.openai.com/v1/responses');
      expect(requestedUrl).not.toContain('attacker.example');
      expect(report.limitations).toContain(
        'Semantic mapping was unavailable; deterministic lexical candidate matching was used.',
      );
      expect(report.criteria[0]?.status).not.toBe('VERIFIED');
    } finally {
      vi.stubGlobal('fetch', originalFetch);
      if (originalOpenAiBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = originalOpenAiBaseUrl;
      await project.cleanup();
    }
  });
});

function providerWith(overrides: Partial<SemanticProvider>): SemanticProvider {
  return {
    name: 'mock',
    decompose: async () => [],
    map: async (criteria: Criterion[], files: CandidateFile[]) =>
      criteria.map((criterion) => ({
        criterionId: criterion.id,
        implementationPaths: files
          .filter((file) => file.changed && !file.test)
          .map((file) => file.path),
        testPaths: files.filter((file) => file.test).map((file) => file.path),
        explanation: 'Mock mapping.',
      })),
    generate: async () => [],
    ...overrides,
  };
}
