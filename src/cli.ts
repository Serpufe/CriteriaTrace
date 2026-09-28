#!/usr/bin/env node
import { Command, Option } from 'commander';
import { mkdir, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { initConfig, loadConfig, failsPolicy } from './config.js';
import { markdownSource } from './criteria.js';
import { fetchIssueSource } from './github.js';
import {
  git,
  remoteUrl,
  repositoryGitState,
  repositoryRoot,
  revision,
  trackedFiles,
} from './git.js';
import { detectFramework } from './execute.js';
import { isolatedAvailability } from './runtime.js';
import { toJson, toMarkdown } from './report.js';
import { redactCommand, redactSensitiveData, redactSensitiveText } from './security.js';
import { inspect, verify, type VerifyOptions } from './verify.js';
import type { RequirementSource, TraceReport } from './types.js';

const program = new Command();
program
  .name('criteriatrace')
  .description('Trace acceptance criteria to changed code, tests, and actual execution evidence.')
  .version('0.1.0')
  .showHelpAfterError();

program
  .command('init')
  .description('Create a versioned .criteriatrace.yml starter configuration.')
  .option('--force', 'replace an existing configuration file')
  .action(async (options: { force?: boolean }) => {
    const root = repositoryRoot(process.cwd());
    const path = await initConfig(root, Boolean(options.force));
    console.log(`Created ${path}`);
  });

addAnalysisCommand('inspect', 'Analyze candidate links without executing repository code.', false);
addAnalysisCommand(
  'verify',
  'Trace criteria; execute repository commands only in an isolated container by default.',
  true,
);

program
  .command('doctor')
  .description(
    'Report repository, runtime, test framework, configuration, provider, Git, and GitHub context.',
  )
  .addOption(
    new Option('--format <format>', 'output format').choices(['text', 'json']).default('text'),
  )
  .action(async (options: { format: 'text' | 'json' }) => {
    const data = await doctor();
    if (options.format === 'json') console.log(JSON.stringify(redactSensitiveData(data), null, 2));
    else printDoctor(data);
  });

program
  .command('demo')
  .description('Run the deterministic offline demo and write Markdown and JSON reports.')
  .option('--output-dir <path>', 'directory for the generated report files', '.criteriatrace-demo')
  .action(async (options: { outputDir: string }) => {
    const report = await runDemo();
    const outputDir = resolve(options.outputDir);
    await mkdir(outputDir, { recursive: true });
    const jsonPath = join(outputDir, 'report.json');
    const markdownPath = join(outputDir, 'report.md');
    await Promise.all([
      writeFile(jsonPath, toJson(report)),
      writeFile(markdownPath, toMarkdown(report)),
    ]);
    console.log(`Demo report: ${markdownPath}`);
    console.log(`JSON evidence: ${jsonPath}`);
    console.log(toMarkdown(report));
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(
    `criteriatrace: ${redactSensitiveText(error instanceof Error ? error.message : String(error))}`,
  );
  process.exitCode = 2;
});

function addAnalysisCommand(
  name: 'inspect' | 'verify',
  description: string,
  execute: boolean,
): void {
  const command = program
    .command(name)
    .description(description)
    .argument('[spec]', 'local Markdown task or specification');
  command
    .option('--issue <number>', 'read a GitHub issue from the repository origin')
    .option('--text <text>', 'use inline task text')
    .option('--base <revision>', 'base Git revision; defaults to config or origin/HEAD')
    .option('--head <revision>', 'head Git revision', 'HEAD')
    .addOption(new Option('--format <format>', 'report format').choices(['markdown', 'json']))
    .option('-o, --output <path>', 'write the report to a file')
    .option('--trust-repo', 'explicitly run repository commands on this host')
    .option('--no-exec', 'analyze statically without running repository commands')
    .option('--allow-network', 'allow container network access (isolated mode only)')
    .action(
      async (
        spec: string | undefined,
        options: {
          issue?: string;
          text?: string;
          base?: string;
          head: string;
          format?: 'markdown' | 'json';
          output?: string;
          trustRepo?: boolean;
          exec?: boolean;
          allowNetwork?: boolean;
        },
      ) => {
        const root = repositoryRoot(process.cwd());
        if (options.trustRepo && options.exec === false)
          throw new Error('--trust-repo and --no-exec cannot be combined.');
        if (options.allowNetwork && (options.trustRepo || options.exec === false))
          throw new Error('--allow-network applies only to isolated execution.');
        const executionMode =
          options.exec === false ? 'no-exec' : options.trustRepo ? 'trusted' : 'isolated';
        if (execute) {
          console.error(
            `Execution mode: ${executionMode}; network: ${executionMode === 'isolated' ? (options.allowNetwork ? 'enabled' : 'disabled') : executionMode === 'trusted' ? 'host policy' : 'none'}; repository secrets: not inherited in isolated mode.`,
          );
        }
        const sources = await loadSources(root, spec, options.issue, options.text);
        const request: VerifyOptions = {
          root,
          sources,
          ...(options.base ? { base: options.base } : {}),
          head: options.head,
          ...(execute ? { executionMode, allowNetwork: options.allowNetwork } : {}),
        };
        const report = execute ? await verify(request) : await inspect(request);
        const format =
          options.format ?? (options.output?.toLowerCase().endsWith('.json') ? 'json' : 'markdown');
        const rendered = format === 'json' ? toJson(report) : toMarkdown(report);
        if (options.output) {
          const path = resolve(options.output);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, rendered);
          console.log(`Wrote ${path}`);
        } else {
          process.stdout.write(rendered);
        }
        if (execute) process.exitCode = await verifyExitCode(report, root, executionMode);
      },
    );
}

async function loadSources(
  root: string,
  spec: string | undefined,
  issueValue: string | undefined,
  text: string | undefined,
): Promise<RequirementSource[]> {
  const sources: RequirementSource[] = [];
  if (spec) {
    const path = resolve(process.cwd(), spec);
    sources.push(markdownSource(spec, await readFile(path, 'utf8')));
  }
  if (issueValue) {
    if (!/^\d+$/.test(issueValue)) throw new Error('--issue must be a positive integer.');
    const remote = remoteUrl(root);
    if (!remote) throw new Error('No origin remote is configured for this repository.');
    sources.push(await fetchIssueSource(remote, Number(issueValue)));
  }
  if (text) sources.push({ id: 'inline-task', kind: 'inline', title: 'Inline task', text });
  if (sources.length === 0) throw new Error('Provide [spec], --issue <number>, or --text <task>.');
  return sources;
}

async function verifyExitCode(
  report: TraceReport,
  root: string,
  executionMode: string,
): Promise<number> {
  if (
    executionMode !== 'no-exec' &&
    report.executions.some(
      (execution) =>
        execution.id.startsWith('head-') && (execution.exitCode !== 0 || execution.timedOut),
    )
  ) {
    return 3;
  }
  let failOn = ['MISSING'];
  try {
    // The report has already validated this same file during analysis.
    const config = await loadConfig(root);
    return failsPolicy(
      report.criteria.map((item) => item.status),
      config.policy.failOn,
    )
      ? 1
      : 0;
  } catch {
    failOn = ['MISSING'];
  }
  return report.criteria.some((item) => failOn.includes(item.status)) ? 1 : 0;
}

async function doctor(): Promise<Record<string, unknown>> {
  const root = repositoryRoot(process.cwd());
  const config = await loadConfig(root);
  let head: string | null = null;
  let paths: string[] = [];
  try {
    head = revision(root, 'HEAD');
    paths = trackedFiles(root, head);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('Needed a single revision'))
      throw error;
  }
  let packageJson: string | undefined;
  let pythonConfig: string | undefined;
  try {
    packageJson = await readFile(join(root, 'package.json'), 'utf8');
  } catch {
    /* Python or non-JS project */
  }
  for (const path of ['pyproject.toml', 'setup.cfg']) {
    try {
      pythonConfig = await readFile(join(root, path), 'utf8');
      break;
    } catch {
      /* try the next config */
    }
  }
  const gitState = repositoryGitState(root);
  const remote = remoteUrl(root);
  return {
    repository: { root, ...(remote ? { remote } : {}) },
    runtime: { node: process.version, platform: process.platform },
    testFramework: detectFramework(packageJson, paths, pythonConfig),
    isolation: {
      node: isolatedAvailability('node:24-alpine'),
      python: isolatedAvailability('python:3.13-alpine'),
    },
    configuration: {
      path: `${root}/.criteriatrace.yml`,
      provider: config.provider,
      verification: config.verification,
      commands: Object.fromEntries(
        Object.entries(config.commands).map(([name, command]) => [
          name,
          command ? redactCommand(command) : command,
        ]),
      ),
    },
    providerStatus:
      config.provider.name === 'mock'
        ? 'Deterministic mock provider configured.'
        : process.env.OPENAI_API_KEY
          ? `OpenAI key is present; model ${config.provider.model} is configured.`
          : 'OpenAI configured but OPENAI_API_KEY is not set; lexical analysis will be used.',
    git: { head, ...gitState },
    github: process.env.GITHUB_ACTIONS
      ? {
          available: true,
          repository: process.env.GITHUB_REPOSITORY ?? null,
          event: process.env.GITHUB_EVENT_NAME ?? null,
          ref: process.env.GITHUB_REF ?? null,
        }
      : { available: false },
  };
}

function printDoctor(data: Record<string, unknown>): void {
  const repository = data.repository as { root: string; remote?: string };
  const runtime = data.runtime as { node: string; platform: string };
  const framework = data.testFramework as { framework: string; reason: string };
  const config = data.configuration as { path: string; provider: { name: string; model: string } };
  console.log(`Repository: ${repository.root}`);
  if (repository.remote) console.log(`Origin: ${repository.remote}`);
  console.log(`Runtime: Node ${runtime.node} (${runtime.platform})`);
  console.log(`Tests: ${framework.framework} — ${framework.reason}`);
  const isolation = data.isolation as { node?: string; python?: string };
  console.log(
    `Isolated execution: ${isolation.node ?? 'Node image ready'}; ${isolation.python ?? 'Python image ready'}`,
  );
  console.log(`Config: ${config.path}`);
  console.log(
    `Provider: ${String(data.providerStatus)} (${config.provider.name}/${config.provider.model})`,
  );
  const gitState = data.git as { status: string; head: string | null; dirty: boolean };
  console.log(`Git status: ${gitState.status.replaceAll('\n', '; ')}`);
  console.log(`Working tree: ${gitState.dirty ? 'dirty' : 'clean'}`);
  console.log(`HEAD: ${gitState.head ?? 'no commit yet'}`);
  const github = data.github as {
    available: boolean;
    repository?: string | null;
    event?: string | null;
  };
  console.log(
    `GitHub context: ${github.available ? `${github.repository ?? 'unknown'} / ${github.event ?? 'unknown'}` : 'not detected'}`,
  );
}

async function runDemo(): Promise<TraceReport> {
  const root = await mkdtemp(join(tmpdir(), 'criteriatrace-demo-'));
  try {
    git(root, ['init', '--quiet', '--initial-branch=main']);
    git(root, ['config', 'user.name', 'CriteriaTrace Demo']);
    git(root, ['config', 'user.email', 'demo@criteriatrace.invalid']);
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'tests'), { recursive: true });
    const test = `import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { exportFilename } from '../src/export.js';\n\n// AC-1: export keeps the exact UTF-8 filename.\ntest('AC-1 preserves UTF-8 filename', () => {\n  assert.equal(exportFilename('café.zip'), 'café.zip');\n});\n`;
    await writeFile(
      join(root, 'src/export.js'),
      `export function exportFilename(name) { return name.replace(/[^\\x00-\\x7F]/g, ''); }\n`,
    );
    await writeFile(join(root, 'tests/export.test.js'), test);
    await writeFile(
      join(root, '.criteriatrace.yml'),
      `version: 1\nprovider:\n  name: mock\n  model: deterministic\nverification:\n  base: HEAD~1\n  counterfactual: true\n  generatedTests: false\ncommands:\n  test: [node, --test]\npolicy:\n  failOn: [MISSING]\n`,
    );
    git(root, ['add', '.']);
    git(root, ['commit', '--quiet', '-m', 'broken archive export']);
    const base = git(root, ['rev-parse', 'HEAD']);
    await writeFile(
      join(root, 'src/export.js'),
      `export function exportFilename(name) { return name; }\n`,
    );
    git(root, ['add', 'src/export.js']);
    git(root, ['commit', '--quiet', '-m', 'preserve UTF-8 archive filename']);
    const source: RequirementSource = {
      id: 'demo-spec',
      kind: 'markdown',
      title: 'Demo acceptance specification',
      text: '# Acceptance criteria\n\n- AC-1: UTF-8 filenames survive archive export.\n',
    };
    const report = await verify({
      root,
      sources: [source],
      base,
      head: 'HEAD',
      executionMode: 'trusted',
    });
    report.repository.root = 'temporary demo fixture (removed after execution)';
    for (const execution of report.executions) {
      execution.output = execution.output.replace(
        /(?:[A-Za-z]:)?[\\/](?:[^\\/\s]+[\\/])*criteriatrace-[^\\/\s]+[\\/]workspace/gi,
        '[temporary workspace]',
      );
    }
    report.limitations.push(
      'This deterministic report was generated from a temporary fixture with the mock semantic provider.',
    );
    return report;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
