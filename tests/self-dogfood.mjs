import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { repositoryGitState } from '../src/git.ts';

test('AC-98 reports clean, tracked-change, and untracked Git states', async () => {
  const root = await mkdtemp(join(tmpdir(), 'criteriatrace-self-dogfood-'));
  function git(args) {
    execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  }

  try {
    git(['init', '--quiet', '--initial-branch=main']);
    git(['config', 'user.name', 'CriteriaTrace Self Dogfood']);
    git(['config', 'user.email', 'self-dogfood@criteriatrace.invalid']);
    await writeFile(join(root, 'tracked.txt'), 'base\n');
    git(['add', 'tracked.txt']);
    git(['commit', '--quiet', '-m', 'clean repository']);

    assert.equal(repositoryGitState(root).dirty, false);
    await writeFile(join(root, 'tracked.txt'), 'modified\n');
    assert.equal(repositoryGitState(root).dirty, true);
    await writeFile(join(root, 'tracked.txt'), 'base\n');
    await writeFile(join(root, 'untracked.txt'), 'new\n');
    assert.equal(repositoryGitState(root).dirty, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
