import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { initConfig, loadConfig, parseConfigText, starterConfig } from '../src/config.js';

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

describe('configuration', () => {
  it('uses safe defaults when no config exists', () => {
    const config = parseConfigText('version: 1\n');
    expect(config.verification.counterfactual).toBe(true);
    expect(config.verification.generatedTests).toBe(false);
    expect(config.policy.failOn).toEqual(['MISSING']);
  });

  it('accepts the exact starter configuration written by init', () => {
    const config = parseConfigText(starterConfig);
    expect(config.commands).toEqual({});
  });

  it('rejects unknown keys and invalid values with a path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'criteriatrace-config-'));
    roots.push(root);
    await writeFile(
      join(root, '.criteriatrace.yml'),
      'version: 1\nverification:\n  counterfactul: true\n',
    );
    await expect(loadConfig(root)).rejects.toThrow('counterfactul');
    expect(() => parseConfigText('version: 2\n')).toThrow('version');
  });

  it('rejects malformed and duplicate YAML keys', () => {
    expect(() => parseConfigText('version: [')).toThrow('Invalid .criteriatrace.yml');
    expect(() => parseConfigText('version: 1\nversion: 1\n')).toThrow('Invalid .criteriatrace.yml');
  });

  it('bounds configuration input size and rejects NUL in command arguments', () => {
    expect(() => parseConfigText(`version: 1\n${' '.repeat(1_048_576)}`)).toThrow('byte limit');
    expect(() => parseConfigText('version: 1\ncommands:\n  test: [node, "\\0"]\n')).toThrow('NUL');
  });

  it.skipIf(process.platform === 'win32')(
    'replaces a config symlink without writing to its target',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'criteriatrace-init-'));
      const outside = await mkdtemp(join(tmpdir(), 'criteriatrace-outside-'));
      roots.push(root, outside);
      const target = join(outside, 'protected.txt');
      await writeFile(target, 'untouched');
      const configPath = join(root, '.criteriatrace.yml');
      await symlink(target, configPath);

      await initConfig(root, true);
      expect(await readFile(target, 'utf8')).toBe('untouched');
      expect((await lstat(configPath)).isFile()).toBe(true);
      expect(await readFile(configPath, 'utf8')).toBe(starterConfig);
    },
  );
});
