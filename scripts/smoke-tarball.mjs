import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import console from 'node:console';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

const tarball = resolve(process.argv[2] ?? '');
assert.ok(process.argv[2], 'Usage: node scripts/smoke-tarball.mjs <tarball>');
const root = mkdtempSync(join(tmpdir(), 'criteriatrace-tarball-'));
const install = join(root, 'install');
const project = join(root, 'project');
const bin = join(install, 'node_modules', '.bin', 'criteriatrace');
const env = { ...process.env, OPENAI_API_KEY: '' };

function run(command, args, cwd, accepted = [0]) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 120_000 });
  assert.ok(
    accepted.includes(result.status ?? -1),
    `${command} ${args.join(' ')} exited ${result.status}: ${result.stderr || result.stdout}`,
  );
  return result;
}

try {
  mkdirSync(install);
  mkdirSync(project);
  run('npm', ['install', '--ignore-scripts', '--prefix', install, tarball], root);
  assert.match(run(bin, ['--help'], project).stdout, /isolated|Docker/i);
  assert.equal(run(bin, ['--version'], project).stdout.trim(), '0.1.0');
  assert.equal(
    run(
      'npm',
      ['exec', '--yes', `--package=file:${tarball}`, '--', 'criteriatrace', '--version'],
      project,
    ).stdout.trim(),
    '0.1.0',
  );
  assert.match(run(bin, ['init'], project, [2]).stderr, /not a Git repository/i);

  run('git', ['init', '--quiet', '-b', 'main'], project);
  run('git', ['config', 'user.name', 'Release Smoke'], project);
  run('git', ['config', 'user.email', 'release-smoke@criteriatrace.invalid'], project);
  mkdirSync(join(project, 'src'));
  mkdirSync(join(project, 'test'));
  writeFileSync(join(project, 'src', 'value.js'), 'export const value = 0;\n');
  writeFileSync(
    join(project, 'test', 'value.test.js'),
    "import { test } from 'node:test'; import { strictEqual } from 'node:assert'; import { value } from '../src/value.js'; test('AC-1 value is one', () => strictEqual(value, 1));\n",
  );
  writeFileSync(join(project, 'package.json'), '{"type":"module"}\n');
  run('git', ['add', '.'], project);
  run('git', ['commit', '--quiet', '-m', 'base'], project);
  writeFileSync(join(project, 'src', 'value.js'), 'export const value = 1;\n');
  run('git', ['add', '.'], project);
  run('git', ['commit', '--quiet', '-m', 'head'], project);
  const base = run('git', ['rev-parse', 'HEAD~1'], project).stdout.trim();
  const head = run('git', ['rev-parse', 'HEAD'], project).stdout.trim();
  run(bin, ['init'], project);
  assert.ok(readFileSync(join(project, '.criteriatrace.yml'), 'utf8').includes('version: 1'));
  writeFileSync(
    join(project, '.criteriatrace.yml'),
    'version: 1\nprovider:\n  name: mock\n  model: deterministic\ncommands:\n  test: [node, --test]\npolicy:\n  failOn: [MISSING]\n',
  );
  assert.match(
    run(
      bin,
      ['inspect', '--text', 'AC-1: value is one', '--base', 'missing-release-sha'],
      project,
      [2],
    ).stderr,
    /Git revision not found.*Check --base and --head/s,
  );
  assert.match(
    run(bin, ['inspect', 'missing-spec.md'], project, [2]).stderr,
    /Check the specification path/,
  );
  const common = [
    '--text',
    'AC-1: value is one',
    '--base',
    base,
    '--head',
    head,
    '--format',
    'json',
  ];
  run(bin, ['inspect', ...common, '--output', 'inspect.json'], project);
  run(bin, ['verify', ...common, '--no-exec', '--output', 'static.json'], project, [0, 1]);
  const execution = run(
    bin,
    ['verify', ...common, '--output', 'isolated.json'],
    project,
    [0, 1, 3],
  );
  for (const name of ['inspect.json', 'static.json', 'isolated.json']) {
    const report = JSON.parse(readFileSync(join(project, name), 'utf8'));
    assert.equal(report.base, base);
    assert.equal(report.head, head);
    assert.ok(Array.isArray(report.criteria));
  }
  const isolated = JSON.parse(readFileSync(join(project, 'isolated.json'), 'utf8'));
  const termination = isolated.executions.find((item) => item.id === 'head-test')?.termination;
  assert.ok(
    ['exit', 'unavailable'].includes(termination),
    `unexpected termination: ${termination}`,
  );
  if (termination === 'unavailable') assert.equal(execution.status, 3);
  console.log(
    `PASS: tarball install, help, version, npx, init, inspect, no-exec, report; isolated=${termination}`,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
