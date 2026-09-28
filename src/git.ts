import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { redactSensitiveText } from './security.js';

export function git(root: string, args: string[], maxBuffer = 16 * 1024 * 1024): string {
  try {
    return execFileSync(
      gitBinary(),
      ['-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', ...args],
      {
        cwd: root,
        env: safeGitEnvironment(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer,
        windowsHide: true,
      },
    ).trimEnd();
  } catch (error) {
    const detail = (error as NodeJS.ErrnoException & { stderr?: Buffer | string }).stderr;
    throw new Error(
      `git ${args.join(' ')} failed: ${detail?.toString().trim() || (error as Error).message}`,
      { cause: error },
    );
  }
}

export function revision(root: string, ref: string): string {
  return git(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
}

export function repositoryRoot(start: string): string {
  return resolve(git(start, ['rev-parse', '--show-toplevel']));
}

export function remoteUrl(root: string): string | undefined {
  try {
    return sanitizeRemote(git(root, ['remote', 'get-url', 'origin']));
  } catch {
    return undefined;
  }
}

function sanitizeRemote(remote: string): string {
  const scp = remote.match(/^([^@/]+)@([^:]+):(.+)$/);
  if (scp) {
    const user = scp[1] === 'git' ? 'git' : '[REDACTED]';
    return `${user}@${scp[2]}:${scp[3]}`;
  }
  try {
    const url = new URL(remote);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return redactSensitiveText(url.toString());
  } catch {
    return redactSensitiveText(remote);
  }
}

export interface RepositoryGitState {
  status: string;
  dirty: boolean;
}

export function repositoryGitState(root: string): RepositoryGitState {
  return {
    status: git(root, ['status', '--short', '--branch']),
    dirty: Boolean(git(root, ['status', '--porcelain'])),
  };
}

export function changedFiles(root: string, base: string, head: string): string[] {
  return git(
    root,
    ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', base, head],
    32 * 1024 * 1024,
  )
    .split('\0')
    .filter(Boolean)
    .filter(isSafeRelativePath);
}

export function trackedFiles(root: string, ref: string): string[] {
  return git(root, ['ls-tree', '-r', '--name-only', '-z', ref], 32 * 1024 * 1024)
    .split('\0')
    .filter(Boolean)
    .filter(isSafeRelativePath);
}

export function fileAt(root: string, ref: string, path: string): string | undefined {
  if (!isSafeRelativePath(path)) return undefined;
  try {
    return git(root, ['show', '--no-textconv', `${ref}:${path}`], 2 * 1024 * 1024);
  } catch {
    return undefined;
  }
}

export function isSafeRelativePath(path: string): boolean {
  return (
    Boolean(path) &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !path.split('/').some((part) => part === '..' || part === '.' || part === '')
  );
}

export async function snapshot(
  root: string,
  ref: string,
): Promise<{ path: string; revision: string; cleanup: () => Promise<void> }> {
  const resolved = revision(root, ref);
  const dir = await mkdtemp(join(tmpdir(), 'criteriatrace-'));
  const target = join(dir, 'workspace');
  try {
    const archive = execFileSync(gitBinary(), ['archive', '--format=tar', resolved], {
      cwd: root,
      env: safeGitEnvironment(),
      maxBuffer: 256 * 1024 * 1024,
      windowsHide: true,
    });
    const archivePath = join(dir, 'source.tar');
    await writeFile(archivePath, archive, { mode: 0o600 });
    await mkdir(target);
    execFileSync(
      process.platform === 'win32' ? 'tar' : '/usr/bin/tar',
      ['-xf', archivePath, '-C', target],
      {
        env: safeGitEnvironment(),
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    await makeArchiveReadable(target);
    await rm(archivePath, { force: true });
    return {
      path: target,
      revision: resolved,
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

export function safeGitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH:
      process.platform === 'win32'
        ? (process.env.PATH ?? '')
        : '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin',
    HOME: '/nonexistent',
    XDG_CONFIG_HOME: '/nonexistent',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    GIT_ALLOW_PROTOCOL: 'https:http:git',
  };
}

export function gitBinary(): string {
  if (process.platform === 'win32') return 'git';
  for (const path of ['/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git'])
    if (existsSync(path)) return path;
  throw new Error('Git is not installed in a trusted system location.');
}

async function makeArchiveReadable(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    await chmod(path, info.mode | 0o555);
    for (const name of await readdir(path)) await makeArchiveReadable(join(path, name));
  } else if (info.isFile()) {
    await chmod(path, info.mode | 0o444);
  }
}

export function normalizeRevision(root: string, ref: string): string {
  return `${basename(root)}@${revision(root, ref).slice(0, 12)}`;
}
