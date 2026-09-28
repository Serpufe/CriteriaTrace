import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandExecution, ExecutionMode } from './types.js';
import { redactCommand, redactSensitiveText } from './security.js';

export interface ExecutionPolicy {
  mode: ExecutionMode;
  allowNetwork: boolean;
  image: string;
  containerName?: string;
}

export interface ExecutionRequest {
  id: string;
  revision: string;
  command: string[];
  workspace: string;
  home?: string;
  timeoutMs: number;
  outputBytes: number;
  policy: ExecutionPolicy;
}

const dockerEnvironment: NodeJS.ProcessEnv = {
  PATH: '/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin',
  // Docker context selection belongs to the trusted parent, never to the container.
  HOME: process.env.HOME ?? '/nonexistent',
};

function dockerBinary(): string {
  for (const path of ['/usr/local/bin/docker', '/opt/homebrew/bin/docker', '/usr/bin/docker'])
    if (existsSync(path)) return path;
  throw new Error('Docker is not installed in a trusted system location.');
}

function commandEnvironment(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: home,
    USERPROFILE: home,
    TMPDIR: home,
    TEMP: home,
    TMP: home,
    CI: 'true',
    NODE_ENV: 'test',
    LANG: 'C.UTF-8',
  };
}

export function isolatedAvailability(image: string): string | undefined {
  try {
    // Never accept a remote daemon or repository-provided Docker endpoint.
    const endpoint = execFileSync(
      dockerBinary(),
      ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
      {
        env: dockerEnvironment,
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim();
    if (!endpoint.startsWith('unix://')) return 'A local Docker Unix socket is required.';
    execFileSync(dockerBinary(), ['info', '--format', '{{.ServerVersion}}'], {
      env: dockerEnvironment,
      timeout: 5000,
      stdio: 'ignore',
    });
    execFileSync(dockerBinary(), ['image', 'inspect', image], {
      env: dockerEnvironment,
      timeout: 5000,
      stdio: 'ignore',
    });
    return undefined;
  } catch {
    return `Local Docker or the ${image} image is unavailable. Install/start Docker and pull the image, or choose --no-exec or --trust-repo.`;
  }
}

export async function startIsolatedSession(
  workspace: string,
  policy: ExecutionPolicy,
): Promise<string | undefined> {
  const unavailable = isolatedAvailability(policy.image);
  if (unavailable) return undefined;
  const name = `criteriatrace-${randomUUID()}`;
  const args = [
    'run',
    '--rm',
    '-d',
    '--pull=never',
    '--name',
    name,
    '--network',
    policy.allowNetwork ? 'bridge' : 'none',
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--pids-limit=64',
    '--memory=512m',
    '--memory-swap=512m',
    '--cpus=1',
    '--ulimit',
    'nofile=1024:1024',
    '--user',
    '65534:65534',
    '--tmpfs',
    '/work:rw,nosuid,nodev,size=256m,mode=1777',
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,size=64m,mode=1777',
    '--mount',
    `type=bind,source=${workspace},target=/source,readonly`,
    '--workdir',
    '/work',
    '--env',
    'HOME=/tmp/home',
    '--env',
    'TMPDIR=/tmp',
    '--env',
    'CI=true',
    '--env',
    'NODE_ENV=test',
    '--env',
    'LANG=C.UTF-8',
    '--entrypoint',
    '/bin/sh',
    policy.image,
    '-c',
    'mkdir -p /tmp/home && cp -R /source/. /work/ && touch /tmp/ready && exec sleep 7200',
  ];
  try {
    execFileSync(dockerBinary(), args, {
      env: dockerEnvironment,
      cwd: workspace,
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1_000_000,
    });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        execFileSync(dockerBinary(), ['exec', name, 'test', '-f', '/tmp/ready'], {
          env: dockerEnvironment,
          timeout: 5000,
          stdio: 'ignore',
        });
        return name;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  } catch {
    /* Return unavailable after cleanup. */
  }
  if (!removeContainer(name))
    throw new Error('Could not confirm failed container startup cleanup.');
  return undefined;
}

export function stopIsolatedSession(name: string): void {
  if (!removeContainer(name)) throw new Error('Could not confirm isolated container cleanup.');
}

export function unavailableExecution(request: ExecutionRequest, reason: string): CommandExecution {
  return {
    id: request.id,
    revision: request.revision,
    command: redactCommand(request.command),
    exitCode: null,
    signal: null,
    timedOut: false,
    outputTruncated: false,
    termination: 'unavailable',
    durationMs: 0,
    output: reason,
    workspace: 'No repository command ran.',
  };
}

export async function executeCommand(request: ExecutionRequest): Promise<CommandExecution> {
  if (request.command.length === 0 || request.command.some((part) => !part || part.includes('\0')))
    throw new Error('Commands must be non-empty argument arrays without NUL bytes.');
  if (request.policy.mode === 'no-exec')
    return unavailableExecution(request, 'Execution disabled by --no-exec.');
  if (request.policy.mode === 'isolated') {
    if (request.policy.containerName) {
      return runProcess(
        request,
        dockerBinary(),
        ['exec', '--workdir', '/work', request.policy.containerName, ...request.command],
        dockerEnvironment,
        request.policy.containerName,
        false,
      );
    }
    return unavailableExecution(
      request,
      isolatedAvailability(request.policy.image) ?? 'No isolated revision session was started.',
    );
  }
  return runProcess(
    request,
    request.command[0]!,
    request.command.slice(1),
    commandEnvironment(request.home ?? join(request.workspace, '..', 'home')),
    undefined,
  );
}

function removeContainer(name: string): boolean {
  const deadline = Date.now() + 5000;
  do {
    try {
      execFileSync(dockerBinary(), ['rm', '-f', name], {
        env: dockerEnvironment,
        timeout: 2000,
        stdio: 'ignore',
      });
    } catch {
      /* Already removed, removal in progress, or daemon unavailable. Confirm below. */
    }
    try {
      const remaining = execFileSync(
        dockerBinary(),
        ['ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.ID}}'],
        {
          env: dockerEnvironment,
          timeout: 2000,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      );
      if (remaining.trim() === '') return true;
    } catch {
      /* A lost daemon cannot confirm cleanup. */
    }
  } while (Date.now() < deadline);
  return false;
}

function isContainerRunning(name: string): boolean {
  try {
    return (
      execFileSync(dockerBinary(), ['inspect', '--format', '{{.State.Running}}', name], {
        env: dockerEnvironment,
        timeout: 5000,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() === 'true'
    );
  } catch {
    return false;
  }
}

function killGroup(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* exited */
    }
  }
}

async function runProcess(
  request: ExecutionRequest,
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  containerName: string | undefined,
  cleanupOnClose = true,
): Promise<CommandExecution> {
  const started = Date.now();
  let output = '';
  let outputSize = 0;
  let outputTruncated = false;
  let termination: CommandExecution['termination'] = 'exit';
  let cleanupFailed = false;
  let child: ChildProcess;
  try {
    child = spawn(executable, args, {
      cwd: request.workspace,
      env,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (error) {
    return unavailableExecution(
      request,
      redactSensitiveText(`Could not start command: ${(error as Error).message}`),
    );
  }
  let stopping = false;
  let pendingStop: Promise<void> | undefined;
  const stop = async (reason: 'timeout' | 'output-limit') => {
    if (stopping) return;
    stopping = true;
    termination = reason;
    if (containerName) {
      if (!removeContainer(containerName)) cleanupFailed = true;
    }
    killGroup(child);
  };
  const collect = (chunk: Buffer) => {
    const remaining = Math.max(0, request.outputBytes - outputSize);
    if (chunk.byteLength > remaining) {
      outputTruncated = true;
      pendingStop = stop('output-limit');
    }
    if (remaining > 0) {
      const kept = chunk.subarray(0, remaining);
      output += kept.toString('utf8');
      outputSize += kept.byteLength;
    }
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  const timer = setTimeout(() => {
    pendingStop = stop('timeout');
  }, request.timeoutMs);
  const onSignal = () => {
    pendingStop = stop('timeout');
    process.exitCode = 130;
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const settled = await new Promise<{
    exitCode: number | null;
    signal: string | null;
    error?: Error;
  }>((resolve) => {
    child.once('error', (error) => resolve({ exitCode: null, signal: null, error }));
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
  });
  clearTimeout(timer);
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  if (pendingStop) await pendingStop;
  if (
    containerName &&
    !cleanupOnClose &&
    termination === 'exit' &&
    !isContainerRunning(containerName)
  ) {
    termination = 'unavailable';
  }
  if (containerName && cleanupOnClose) {
    // --rm removes a normal exit; force removal also kills background descendants.
    if (!removeContainer(containerName)) cleanupFailed = true;
  }
  if (settled.error) termination = 'start-failed';
  if (cleanupFailed) termination = 'unavailable';
  return {
    id: request.id,
    revision: request.revision,
    command: redactCommand(request.command),
    exitCode: termination === 'exit' ? settled.exitCode : null,
    signal: settled.signal,
    timedOut: (termination as CommandExecution['termination']) === 'timeout',
    outputTruncated,
    termination,
    durationMs: Date.now() - started,
    output: redactSensitiveText(
      cleanupFailed
        ? `${output}\nContainer cleanup could not be confirmed.`
        : settled.error
          ? `Could not start command: ${settled.error.message}`
          : output,
    ),
    workspace: cleanupFailed
      ? 'Container cleanup could not be confirmed.'
      : termination === 'unavailable' && containerName
        ? 'Container was unavailable during execution.'
        : containerName
          ? 'Ephemeral container; source archive mounted read-only; removed after execution.'
          : 'Temporary Git archive; trusted host execution.',
  };
}
