import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import console from 'node:console';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

const action = resolve('action/dist/index.js');
const root = mkdtempSync(join(tmpdir(), 'criteriatrace-action-smoke-'));
const project = join(root, 'project');

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 120_000 });
  assert.equal(result.status, 0, `${command} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

try {
  mkdirSync(project);
  run('git', ['init', '--quiet', '-b', 'main'], project);
  run('git', ['config', 'user.name', 'Action Smoke'], project);
  run('git', ['config', 'user.email', 'action-smoke@criteriatrace.invalid'], project);
  mkdirSync(join(project, 'src'));
  mkdirSync(join(project, 'test'));
  writeFileSync(join(project, 'src', 'value.js'), 'export const value = 0;\n');
  writeFileSync(
    join(project, 'test', 'value.test.js'),
    "import { test } from 'node:test'; import { strictEqual } from 'node:assert'; import { value } from '../src/value.js'; test('AC-1 value is one', () => strictEqual(value, 1));\n",
  );
  writeFileSync(join(project, 'package.json'), '{"type":"module"}\n');
  writeFileSync(
    join(project, '.criteriatrace.yml'),
    'version: 1\nprovider:\n  name: mock\n  model: deterministic\ncommands:\n  test: [node, --test]\npolicy:\n  failOn: [MISSING]\n',
  );
  run('git', ['add', '.'], project);
  run('git', ['commit', '--quiet', '-m', 'base'], project);
  const base = run('git', ['rev-parse', 'HEAD'], project);
  writeFileSync(join(project, 'src', 'value.js'), 'export const value = 1;\n');
  run('git', ['add', '.'], project);
  run('git', ['commit', '--quiet', '-m', 'head'], project);
  const head = run('git', ['rev-parse', 'HEAD'], project);
  const event = {
    pull_request: {
      number: 1,
      title: 'AC-1 value is one',
      body: '# Acceptance criteria\n- AC-1: value is one',
      html_url: 'https://github.com/example/fixture/pull/1',
      base: { sha: base, repo: { full_name: 'example/fixture' } },
      head: { sha: head, repo: { full_name: 'example/fixture' } },
    },
  };
  const eventPath = join(root, 'event.json');
  writeFileSync(eventPath, JSON.stringify(event));
  const summaryPath = join(root, 'summary.md');
  const outputPath = join(root, 'outputs.txt');
  writeFileSync(summaryPath, '');
  writeFileSync(outputPath, '');
  const env = {
    ...process.env,
    OPENAI_API_KEY: '',
    GITHUB_TOKEN: '',
    GITHUB_ACTIONS: 'true',
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_WORKSPACE: project,
    GITHUB_REPOSITORY: 'example/fixture',
    GITHUB_RUN_ID: 'smoke',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_STEP_SUMMARY: summaryPath,
    GITHUB_OUTPUT: outputPath,
    RUNNER_TEMP: root,
  };
  run('node', [action], project, env);
  const report = JSON.parse(
    readFileSync(join(root, 'criteriatrace', 'smoke-1', 'report.json'), 'utf8'),
  );
  assert.equal(report.base, base);
  assert.equal(report.head, head);
  assert.deepEqual(report.executionPolicy, { mode: 'isolated', network: 'disabled' });
  assert.equal(report.executions.find((item) => item.id === 'head-test')?.exitCode, 0);
  assert.equal(report.summary.VERIFIED, 0);
  assert.ok(readFileSync(summaryPath, 'utf8').includes('CriteriaTrace report'));
  assert.ok(readFileSync(outputPath, 'utf8').includes('json-report-path'));
  console.log(
    'PASS: bundled Action, exact revisions, isolated Docker, report outputs, and no forged VERIFIED',
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
