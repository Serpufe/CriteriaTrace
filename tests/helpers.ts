import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const brokenExporter = String.raw`export function exportFilename(name) { return name.replace(/[^\x00-\x7f]/g, ''); }
`;
export const fixedExporter = `export function exportFilename(name) { return name; }\n`;
export const utf8Test = `import assert from 'node:assert/strict';
import test from 'node:test';
import { exportFilename } from '../src/export.js';

// AC-1: this executable test covers UTF-8 filename preservation.
test('AC-1 preserves UTF-8 filename', () => {
  assert.equal(exportFilename('café.zip'), 'café.zip');
});
`;

export interface TestProject {
  root: string;
  base: string;
  commitHead: () => Promise<void>;
  write: (path: string, content: string) => Promise<void>;
  cleanup: () => Promise<void>;
}

export async function createProject(
  options: {
    sourceBase?: string;
    sourceHead?: string;
    testSource?: string;
    withTest?: boolean;
    generatedTests?: boolean;
    testCommand?: string[];
    generatedTestCommand?: string[];
    timeoutSeconds?: number;
  } = {},
): Promise<TestProject> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'criteriatrace-test-')));
  await mkdir(join(root, 'src'), { recursive: true });
  if (options.withTest !== false) await mkdir(join(root, 'tests'), { recursive: true });
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'trace-fixture', type: 'module' }, null, 2),
  );
  await writeFile(join(root, 'src/export.js'), options.sourceBase ?? brokenExporter);
  if (options.withTest !== false)
    await writeFile(join(root, 'tests/export.test.mjs'), options.testSource ?? utf8Test);
  await writeFile(join(root, '.criteriatrace.yml'), configText(options));
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'CriteriaTrace Tests'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'tests@criteriatrace.invalid'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '--quiet', '-m', 'base fixture'], { cwd: root });
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

  async function write(path: string, content: string): Promise<void> {
    const absolute = join(root, path);
    await mkdir(join(absolute, '..'), { recursive: true });
    await writeFile(absolute, content);
  }

  async function commitHead(): Promise<void> {
    await write('src/export.js', options.sourceHead ?? fixedExporter);
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['commit', '--quiet', '-m', 'head fixture'], { cwd: root });
  }

  await commitHead();
  return {
    root,
    base,
    commitHead,
    write,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

export async function createRegressionFixture(): Promise<TestProject> {
  const fixture = fileURLToPath(new URL('./fixtures/regression/', import.meta.url));
  const root = await realpath(await mkdtemp(join(tmpdir(), 'criteriatrace-fixture-')));
  await cp(fixture, root, { recursive: true });
  const headSource = await readFile(join(root, 'src/export.js'), 'utf8');
  const baseSource = await readFile(join(root, 'base/src/export.js'), 'utf8');
  await writeFile(join(root, 'src/export.js'), baseSource);
  await rm(join(root, 'base'), { recursive: true, force: true });
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'CriteriaTrace Fixture'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'fixture@criteriatrace.invalid'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '--quiet', '-m', 'regression base'], { cwd: root });
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  await writeFile(join(root, 'src/export.js'), headSource);
  execFileSync('git', ['add', 'src/export.js'], { cwd: root });
  execFileSync('git', ['commit', '--quiet', '-m', 'preserve UTF-8 names'], { cwd: root });
  return {
    root,
    base,
    commitHead: async () => {},
    write: async (path, content) => {
      const absolute = join(root, path);
      await mkdir(join(absolute, '..'), { recursive: true });
      await writeFile(absolute, content);
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function configText(options: {
  generatedTests?: boolean;
  testCommand?: string[];
  generatedTestCommand?: string[];
  timeoutSeconds?: number;
}): string {
  const testCommand = options.testCommand ?? ['node', '--test'];
  const generatedTest = options.generatedTestCommand ?? ['node', '--test', '{testFile}'];
  const yamlArray = (array: string[]) =>
    `[${array.map((item) => JSON.stringify(item)).join(', ')}]`;
  return [
    'version: 1',
    'provider:',
    '  name: mock',
    '  model: deterministic',
    'verification:',
    '  base: HEAD~1',
    '  counterfactual: true',
    `  generatedTests: ${options.generatedTests ?? false}`,
    'commands:',
    `  test: ${yamlArray(testCommand)}`,
    ...(options.generatedTests ? [`  generatedTest: ${yamlArray(generatedTest)}`] : []),
    'limits:',
    `  commandTimeoutSeconds: ${options.timeoutSeconds ?? 5}`,
    'policy:',
    '  failOn: [MISSING]',
    '',
  ].join('\n');
}
