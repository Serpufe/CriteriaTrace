import { lstat, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { CommandExecution, CriteriaTraceConfig, ExecutionMode } from './types.js';
import { snapshot } from './git.js';
import {
  executeCommand,
  isolatedAvailability,
  startIsolatedSession,
  stopIsolatedSession,
  unavailableExecution,
  type ExecutionPolicy,
} from './runtime.js';

export type Framework = 'vitest' | 'jest' | 'pytest' | 'unsupported';

export interface FrameworkInfo {
  framework: Framework;
  testCommand?: string[];
  reason: string;
}

function pythonExecutable(): string {
  return process.platform === 'win32' ? 'python' : 'python3';
}

export function detectFramework(
  packageJson: string | undefined,
  filePaths: string[],
  pythonConfig?: string,
): FrameworkInfo {
  let parsed: {
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  } = {};
  if (packageJson) {
    try {
      parsed = JSON.parse(packageJson) as typeof parsed;
    } catch {
      return { framework: 'unsupported', reason: 'package.json is malformed.' };
    }
  }
  const dependencies = { ...parsed.dependencies, ...parsed.devDependencies };
  if (dependencies.vitest) {
    return {
      framework: 'vitest',
      testCommand: ['node', 'node_modules/vitest/vitest.mjs', 'run'],
      reason: 'Found the Vitest dependency in package.json.',
    };
  }
  if (dependencies.jest) {
    return {
      framework: 'jest',
      testCommand: ['node', 'node_modules/jest/bin/jest.js', '--runInBand'],
      reason: 'Found the Jest dependency in package.json.',
    };
  }
  const pytestConfigured =
    filePaths.some((path) => path === 'pytest.ini' || path === 'pytest.cfg') ||
    Boolean(pythonConfig && /(?:tool\.pytest|\[tool:pytest\]|pytest)/i.test(pythonConfig));
  if (
    pytestConfigured ||
    filePaths.some((path) => /(?:^|\/)(?:test_[^/]+|[^/]+_test)\.py$/.test(path))
  ) {
    return {
      framework: 'pytest',
      testCommand: [pythonExecutable(), '-m', 'pytest', '-q'],
      reason: 'Found pytest configuration or Python test files.',
    };
  }
  if (parsed.scripts?.test) {
    return {
      framework: 'unsupported',
      reason:
        'A test script exists, but no supported framework was detected. Configure commands.test explicitly.',
    };
  }
  return {
    framework: 'unsupported',
    reason: 'No supported Vitest, Jest, or pytest setup was detected.',
  };
}

export async function executeRevision(options: {
  root: string;
  ref: string;
  revisionLabel: string;
  config: CriteriaTraceConfig;
  framework: FrameworkInfo;
  generated?: { fileName: string; source: string };
  generatedTarget?: boolean;
  executionMode?: ExecutionMode;
  allowNetwork?: boolean | undefined;
}): Promise<CommandExecution[]> {
  const { root, ref, revisionLabel, config, framework, generated, generatedTarget } = options;
  const policy: ExecutionPolicy = {
    mode: options.executionMode ?? 'isolated',
    allowNetwork: options.allowNetwork ?? false,
    image: framework.framework === 'pytest' ? 'python:3.13-alpine' : 'node:24-alpine',
  };
  const checkout = await snapshot(root, ref);
  let sessionName: string | undefined;
  try {
    const home = await mkdtemp(join(dirname(checkout.path), 'home-'));
    if (generatedTarget) {
      if (!generated) throw new Error('A generated test was requested without test source.');
      if (
        !/^__criteriatrace__\/[A-Za-z0-9_-]+\.(?:test\.[cm]?[jt]sx?|spec\.[cm]?[jt]sx?|py)$/.test(
          generated.fileName,
        )
      )
        throw new Error(`Unsafe generated test filename: ${generated.fileName}`);
      await writeGeneratedFile(checkout.path, generated.fileName, generated.source);
    }
    if (policy.mode === 'isolated') {
      sessionName = await startIsolatedSession(checkout.path, policy);
      if (!sessionName) {
        const command =
          config.commands.setup ?? config.commands.test ?? framework.testCommand ?? [];
        return [
          unavailableExecution(
            {
              id: `${revisionLabel}-${config.commands.setup ? 'setup' : 'test'}`,
              revision: checkout.revision,
              command,
              workspace: checkout.path,
              home,
              timeoutMs: config.limits.commandTimeoutSeconds * 1000,
              outputBytes: config.limits.maxCommandOutputBytes,
              policy,
            },
            isolatedAvailability(policy.image) ?? 'Isolated container could not start.',
          ),
        ];
      }
      policy.containerName = sessionName;
    }
    const executions: CommandExecution[] = [];
    if (config.commands.setup) {
      const setup = await executeCommand({
        id: `${revisionLabel}-setup`,
        revision: checkout.revision,
        command: config.commands.setup,
        workspace: checkout.path,
        home,
        policy,
        timeoutMs: config.limits.commandTimeoutSeconds * 1000,
        outputBytes: config.limits.maxCommandOutputBytes,
      });
      executions.push(setup);
      if (setup.exitCode !== 0 || setup.timedOut) return executions;
    }

    let command = config.commands.test ?? framework.testCommand;
    if (generatedTarget) {
      const relativePath = generated!.fileName;
      if (config.commands.generatedTest) {
        command = config.commands.generatedTest.map((part) =>
          part.replaceAll('{testFile}', relativePath),
        );
        if (!config.commands.generatedTest.some((part) => part.includes('{testFile}')))
          command.push(relativePath);
      } else if (framework.framework === 'pytest') {
        command = [pythonExecutable(), '-m', 'pytest', '-q', relativePath];
      } else if (framework.framework === 'vitest') {
        command = ['node', 'node_modules/vitest/vitest.mjs', 'run', relativePath];
      } else if (framework.framework === 'jest') {
        command = ['node', 'node_modules/jest/bin/jest.js', '--runInBand', relativePath];
      } else {
        command = undefined;
      }
    }
    if (!command) {
      return [
        makeSkippedExecution(
          revisionLabel,
          checkout.revision,
          generatedTarget
            ? 'No generated-test runner is configured for this framework.'
            : 'No test command is configured or supported framework detected.',
        ),
      ];
    }
    executions.push(
      await executeCommand({
        id: generatedTarget ? `${revisionLabel}-generated-test` : `${revisionLabel}-test`,
        revision: checkout.revision,
        command,
        workspace: checkout.path,
        home,
        policy,
        timeoutMs: config.limits.commandTimeoutSeconds * 1000,
        outputBytes: config.limits.maxCommandOutputBytes,
      }),
    );
    return executions;
  } finally {
    try {
      if (sessionName) stopIsolatedSession(sessionName);
    } finally {
      await checkout.cleanup();
    }
  }
}

async function writeGeneratedFile(
  root: string,
  relativePath: string,
  source: string,
): Promise<void> {
  const destination = join(root, ...relativePath.split('/'));
  const parent = dirname(destination);
  const relativeParent = relativePath.split('/').slice(0, -1);
  let current = root;
  for (const segment of relativeParent) {
    current = join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory())
        throw new Error(`Unsafe path component: ${segment}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(current);
    }
  }
  await mkdir(parent, { recursive: true });
  await writeFile(destination, source, { flag: 'wx', mode: 0o644 });
}

function makeSkippedExecution(id: string, revision: string, message: string): CommandExecution {
  return {
    id: `${id}-test`,
    revision,
    command: [],
    exitCode: null,
    signal: null,
    timedOut: false,
    outputTruncated: false,
    durationMs: 0,
    output: message,
    workspace: 'No repository command ran.',
  };
}
