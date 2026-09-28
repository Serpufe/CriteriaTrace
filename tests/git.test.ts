import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { remoteUrl, repositoryGitState } from '../src/git.js';
import { createProject } from './helpers.js';

describe('repository Git state', () => {
  it.skipIf(process.platform === 'win32')(
    'ignores a repository-controlled Git binary in PATH',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'criteriatrace-git-path-'));
      const marker = join(dir, 'called');
      const original = process.env.PATH;
      const project = await createProject();
      try {
        await writeFile(join(dir, 'git'), `#!/bin/sh\nprintf bad > "${marker}"\n`);
        await chmod(join(dir, 'git'), 0o755);
        process.env.PATH = `${dir}:${original ?? ''}`;
        repositoryGitState(project.root);
        await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        if (original === undefined) delete process.env.PATH;
        else process.env.PATH = original;
        await project.cleanup();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
  it('reports clean, modified, and untracked working trees', async () => {
    const project = await createProject();
    try {
      expect(repositoryGitState(project.root).dirty).toBe(false);

      await project.write('src/export.js', 'export function modified() { return true; }\n');
      expect(repositoryGitState(project.root).dirty).toBe(true);

      await project.write(
        'src/export.js',
        'export function exportFilename(name) { return name; }\n',
      );
      await project.write('src/untracked.js', 'export const newFile = true;\n');
      const state = repositoryGitState(project.root);
      expect(state.dirty).toBe(true);
      expect(state.status).toContain('?? src/untracked.js');
    } finally {
      await project.cleanup();
    }
  });

  it('removes remote URL credentials before exposing the origin', async () => {
    const project = await createProject();
    try {
      execFileSync(
        'git',
        [
          'remote',
          'add',
          'origin',
          'https://user:private-pass@example.com/owner/repo.git?access_token=private-query',
        ],
        { cwd: project.root },
      );
      const remote = remoteUrl(project.root);
      expect(remote).toContain('example.com/owner/repo.git');
      expect(remote).not.toContain('user');
      expect(remote).not.toContain('private-pass');
      expect(remote).not.toContain('private-query');
    } finally {
      await project.cleanup();
    }
  });

  it('does not expose unrecognized query credentials in remote metadata', async () => {
    const project = await createProject();
    try {
      execFileSync(
        'git',
        [
          'remote',
          'add',
          'origin',
          'https://example.invalid/o/r.git?pat=fixture-secret#another-fixture-secret',
        ],
        {
          cwd: project.root,
        },
      );
      expect(remoteUrl(project.root)).not.toContain('fixture-secret');
    } finally {
      await project.cleanup();
    }
  });

  it.skipIf(process.platform === 'win32')(
    'does not execute a repository fsmonitor during status',
    async () => {
      const project = await createProject();
      try {
        const marker = join(project.root, 'monitor-called');
        const monitor = join(project.root, 'monitor.sh');
        await writeFile(monitor, `#!/bin/sh\nprintf called > "${marker}"\n`);
        await chmod(monitor, 0o700);
        execFileSync('git', ['config', 'core.fsmonitor', monitor], { cwd: project.root });
        repositoryGitState(project.root);
        await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        await project.cleanup();
      }
    },
  );
});
