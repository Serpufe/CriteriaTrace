import { createServer } from 'node:net';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectFramework, executeRevision } from '../src/execute.js';
import { loadConfig } from '../src/config.js';
import { isolatedAvailability, executeCommand } from '../src/runtime.js';
import { createProject } from './helpers.js';

const available = !isolatedAvailability('node:24-alpine');
const framework = detectFramework(undefined, []);

async function runInProject(
  command: string[],
  mode: 'isolated' | 'trusted' = 'isolated',
  timeoutSeconds = 3,
) {
  const project = await createProject({ testCommand: command, timeoutSeconds });
  try {
    const config = await loadConfig(project.root);
    return (
      await executeRevision({
        root: project.root,
        ref: 'HEAD',
        revisionLabel: 'head',
        config,
        framework,
        executionMode: mode,
      })
    ).at(-1)!;
  } finally {
    await project.cleanup();
  }
}

describe('execution policy and adversarial repository commands', () => {
  it.skipIf(process.platform === 'win32')(
    'ignores a repository-controlled Docker binary in PATH',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'criteriatrace-path-'));
      const marker = join(dir, 'called');
      const original = process.env.PATH;
      try {
        await writeFile(join(dir, 'docker'), `#!/bin/sh\nprintf bad > "${marker}"\n`);
        await chmod(join(dir, 'docker'), 0o755);
        process.env.PATH = `${dir}:${original ?? ''}`;
        isolatedAvailability('node:24-alpine');
        await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        if (original === undefined) delete process.env.PATH;
        else process.env.PATH = original;
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
  it('fails closed when isolation is unavailable', async () => {
    const canaryDir = await mkdtemp(join(tmpdir(), 'criteriatrace-canary-'));
    const canary = join(canaryDir, 'outside');
    await writeFile(canary, 'fictional-canary');
    try {
      const result = await runInProject([
        'node',
        '-e',
        `require('fs').readFileSync(${JSON.stringify(canary)}, 'utf8')`,
      ]);
      if (!available) {
        expect(result.termination).toBe('unavailable');
        expect(result.exitCode).toBeNull();
      } else {
        expect(result.output).not.toContain('fictional-canary');
      }
    } finally {
      await rm(canaryDir, { recursive: true, force: true });
    }
  });

  it('stops an output bomb at the configured byte budget', async () => {
    const result = await executeCommand({
      id: 'bomb',
      revision: 'fixture',
      command: ['node', '-e', 'for (;;) process.stdout.write("x".repeat(65536))'],
      workspace: tmpdir(),
      timeoutMs: 5000,
      outputBytes: 1024,
      policy: { mode: 'trusted', allowNetwork: false, image: 'node:24-alpine' },
    });
    expect(
      result.termination,
      JSON.stringify({
        exit: result.exitCode,
        output: result.output.slice(0, 200),
        truncated: result.outputTruncated,
      }),
    ).toBe('output-limit');
    expect(result.outputTruncated).toBe(true);
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(1024);
  });
});

describe.skipIf(!available)('live isolated container attacks', () => {
  it('passes shell metacharacters, leading dashes, spaces, and Unicode as literal arguments', async () => {
    const argument = '--name=$(touch injected) café';
    const result = await runInProject([
      'node',
      '-e',
      "const fs=require('fs'); console.log(JSON.stringify({arg:process.argv[1],injected:fs.existsSync('injected')}))",
      '--',
      argument,
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(JSON.stringify({ arg: argument, injected: false }));
  });
  it('keeps setup artifacts for the test in the same private workspace', async () => {
    const project = await createProject();
    try {
      const config = await loadConfig(project.root);
      config.commands = {
        setup: ['node', '-e', "require('fs').writeFileSync('setup-marker', 'ready')"],
        test: ['node', '-e', "console.log(require('fs').readFileSync('setup-marker', 'utf8'))"],
      };
      const result = await executeRevision({
        root: project.root,
        ref: 'HEAD',
        revisionLabel: 'head',
        config,
        framework,
      });
      expect(result.map((item) => item.exitCode)).toEqual([0, 0]);
      expect(result[1]?.output).toContain('ready');
    } finally {
      await project.cleanup();
    }
  });
  it('denies host files, HOME, external writes, symlink escapes, and secret environment', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'criteriatrace-canary-'));
    const outside = join(dir, 'outside');
    const hostTmpCanary = join('/tmp', `criteriatrace-canary-${Date.now()}`);
    const homeCanary = join(homedir(), `.criteriatrace-canary-${Date.now()}`);
    const oldSecret = process.env.CRITERIATRACE_FAKE_SECRET;
    process.env.CRITERIATRACE_FAKE_SECRET = 'super-secret-test-value';
    await writeFile(outside, 'outside-fictional');
    await writeFile(hostTmpCanary, 'tmp-fictional');
    await writeFile(homeCanary, 'home-fictional');
    const script = `const fs=require('fs');fs.symlinkSync(${JSON.stringify(outside)},'late-link');for (const [name,path] of Object.entries({outside:${JSON.stringify(outside)},home:${JSON.stringify(homeCanary)},tmp:${JSON.stringify(hostTmpCanary)},link:'escape-link',late:'late-link'})) {try {console.log(name+':'+fs.readFileSync(path,'utf8'))} catch {console.log(name+':DENIED')}} try {fs.writeFileSync(${JSON.stringify(join(dir, 'write'))},'bad');console.log('WRITE_OK')} catch {console.log('WRITE_DENIED')} console.log('ENV_VALUE:'+String(process.env.CRITERIATRACE_FAKE_SECRET));console.log('SOCKET:'+fs.existsSync('/var/run/docker.sock'));`;
    const project = await createProject({ testCommand: ['node', '-e', script] });
    try {
      await symlink(outside, join(project.root, 'escape-link'));
      await project.commitHead();
      const result = (
        await executeRevision({
          root: project.root,
          ref: 'HEAD',
          revisionLabel: 'head',
          config: await loadConfig(project.root),
          framework,
        })
      ).at(-1)!;
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('outside:DENIED');
      expect(result.output).toContain('home:DENIED');
      expect(result.output).toContain('tmp:DENIED');
      expect(result.output).toContain('link:DENIED');
      expect(result.output).toContain('late:DENIED');
      expect(result.output).toContain('WRITE_DENIED');
      expect(result.output).toContain('ENV_VALUE:undefined');
      expect(result.output).toContain('SOCKET:false');
      await expect(readFile(join(dir, 'write'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      if (oldSecret === undefined) delete process.env.CRITERIATRACE_FAKE_SECRET;
      else process.env.CRITERIATRACE_FAKE_SECRET = oldSecret;
      await project.cleanup();
      await rm(homeCanary, { force: true });
      await rm(hostTmpCanary, { force: true });
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('cannot reach a host localhost listener with network disabled', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP port');
    try {
      const script = `const net=require('net');const s=net.connect({host:'127.0.0.1',port:${address.port}});s.on('connect',()=>{console.log('CONNECTED');process.exit(1)});s.on('error',()=>{console.log('DENIED');process.exit(0)});setTimeout(()=>process.exit(2),1000);`;
      const result = await runInProject(['node', '-e', script]);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('DENIED');
    } finally {
      server.close();
    }
  });

  it('kills a persistent child and removes its container on timeout', async () => {
    const script = `require('child_process').spawn('node',['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}).unref();setInterval(()=>{},1000)`;
    const result = await runInProject(['node', '-e', script], 'isolated', 1);
    expect(result.termination).toBe('timeout');
    expect(result.workspace).toContain('removed after execution');
  });

  it('removes the container when a repository test floods output', async () => {
    const result = await runInProject([
      'node',
      '-e',
      'const fs=require("fs"), chunk=Buffer.alloc(65536,120); for (;;) fs.writeSync(1,chunk)',
    ]);
    expect(
      result.termination,
      JSON.stringify({
        exit: result.exitCode,
        output: result.output.slice(0, 200),
        truncated: result.outputTruncated,
      }),
    ).toBe('output-limit');
    expect(result.outputTruncated).toBe(true);
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(100_000);
  });
});
