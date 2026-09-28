import { describe, expect, it } from 'vitest';
import { mkdtemp, realpath, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectFramework, executeRevision } from '../src/execute.js';
import { createProject } from './helpers.js';
import { loadConfig } from '../src/config.js';

describe('test framework adapters and process limits', () => {
  it('explains how to fix a configured command that cannot start', async () => {
    const project = await createProject({ testCommand: ['criteriatrace-missing-executable'] });
    try {
      const result = await executeRevision({
        executionMode: 'trusted',
        root: project.root,
        ref: 'HEAD',
        revisionLabel: 'head',
        config: await loadConfig(project.root),
        framework: detectFramework(undefined, []),
      });
      expect(result.at(-1)?.termination).toBe('start-failed');
      expect(result.at(-1)?.output).toContain('Check the configured executable and PATH.');
    } finally {
      await project.cleanup();
    }
  });

  it('detects Vitest, Jest, pytest, and unsupported projects', () => {
    expect(detectFramework('{"devDependencies":{"vitest":"1"}}', []).framework).toBe('vitest');
    expect(detectFramework('{"devDependencies":{"jest":"1"}}', []).framework).toBe('jest');
    expect(detectFramework(undefined, ['tests/test_api.py']).framework).toBe('pytest');
    expect(
      detectFramework(undefined, ['pyproject.toml'], '[tool.pytest.ini_options]').framework,
    ).toBe('pytest');
    expect(
      detectFramework(undefined, ['pyproject.toml'], '[project]\nname = "example"').framework,
    ).toBe('unsupported');
    expect(detectFramework('{"scripts":{"test":"custom"}}', []).framework).toBe('unsupported');
  });

  it('kills a command after the configured timeout in an isolated archive', async () => {
    const project = await createProject({
      sourceHead: 'export function exportFilename(name) { return name; }\n',
      withTest: false,
      testCommand: ['node', '-e', 'setTimeout(() => {}, 5000)'],
      timeoutSeconds: 1,
    });
    try {
      const config = await loadConfig(project.root);
      const framework = detectFramework('{"type":"module"}', []);
      const result = await executeRevision({
        executionMode: 'trusted',
        root: project.root,
        ref: 'HEAD',
        revisionLabel: 'timeout',
        config,
        framework,
      });
      expect(result.at(-1)?.timedOut).toBe(true);
      expect(result.at(-1)?.workspace).toContain('trusted host');
    } finally {
      await project.cleanup();
    }
  });

  it.skipIf(process.platform === 'win32')(
    'keeps temporary HOME outside repository-controlled symlinks',
    async () => {
      const external = await mkdtemp(join(tmpdir(), 'criteriatrace-home-target-'));
      const project = await createProject({
        testCommand: [
          'node',
          '-e',
          "console.log(require('node:fs').realpathSync(process.env.HOME))",
        ],
      });
      try {
        await symlink(external, join(project.root, '.criteriatrace-home'));
        await project.commitHead();
        const result = await executeRevision({
          executionMode: 'trusted',
          root: project.root,
          ref: 'HEAD',
          revisionLabel: 'head',
          config: await loadConfig(project.root),
          framework: detectFramework(undefined, []),
        });
        expect(result.at(-1)?.output.trim()).not.toBe(await realpath(external));
      } finally {
        await project.cleanup();
        await rm(external, { recursive: true, force: true });
      }
    },
  );

  it('executes configured arguments unchanged while redacting the reported command', async () => {
    const project = await createProject({
      testCommand: [
        'node',
        '-e',
        "const expected = ['--', 'token', '=fixture-value'].join(''); console.log(process.argv[1] === expected ? 'ARG_OK' : 'ARG_BAD')",
        '--',
        '--token=fixture-value',
      ],
    });
    try {
      const result = await executeRevision({
        executionMode: 'trusted',
        root: project.root,
        ref: 'HEAD',
        revisionLabel: 'head',
        config: await loadConfig(project.root),
        framework: detectFramework(undefined, []),
      });
      expect(result.at(-1)?.output).toContain('ARG_OK');
      expect(result.at(-1)?.command).toContain('--token=[REDACTED]');
    } finally {
      await project.cleanup();
    }
  });

  it('redacts command arguments when the executable cannot start', async () => {
    const project = await createProject({
      testCommand: [
        'criteriatrace-command-that-does-not-exist',
        '--token',
        'fixture-command-secret',
      ],
    });
    try {
      const result = await executeRevision({
        executionMode: 'trusted',
        root: project.root,
        ref: 'HEAD',
        revisionLabel: 'head',
        config: await loadConfig(project.root),
        framework: detectFramework(undefined, []),
      });
      expect(result.at(-1)?.exitCode).toBeNull();
      expect(result.at(-1)?.command).toEqual([
        'criteriatrace-command-that-does-not-exist',
        '--token',
        '[REDACTED]',
      ]);
    } finally {
      await project.cleanup();
    }
  });
});
