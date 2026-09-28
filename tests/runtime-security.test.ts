import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectFramework, executeRevision } from '../src/execute.js';
import { loadConfig } from '../src/config.js';
import {
  isolatedAvailability,
  executeCommand,
  startIsolatedSession,
  stopIsolatedSession,
} from '../src/runtime.js';
import { createProject } from './helpers.js';

const available = !isolatedAvailability('node:24-alpine');
const framework = detectFramework(undefined, []);

it('requires a working local Docker daemon and pre-pulled image in Linux isolation CI', () => {
  if (process.env.CRITERIATRACE_REQUIRE_DOCKER === '1') {
    expect(process.platform).toBe('linux');
    expect(isolatedAvailability('node:24-alpine')).toBeUndefined();
  }
});

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

  it('never falls back to host execution when the required image is absent', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'criteriatrace-no-image-'));
    const marker = join(workspace, 'host-executed');
    try {
      const result = await executeCommand({
        id: 'missing-image',
        revision: 'fixture',
        command: ['node', '-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`],
        workspace,
        timeoutMs: 1000,
        outputBytes: 1024,
        policy: {
          mode: 'isolated',
          allowNetwork: false,
          image: 'criteriatrace-fixture-image:deliberately-absent',
        },
      });
      expect(result.termination).toBe('unavailable');
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(workspace, { recursive: true, force: true });
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
  it('applies Linux container limits and network none to the actual Docker session', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'criteriatrace-limits-'));
    let name: string | undefined;
    try {
      name = await startIsolatedSession(workspace, {
        mode: 'isolated',
        allowNetwork: false,
        image: 'node:24-alpine',
      });
      expect(name).toBeDefined();
      const inspected = JSON.parse(
        execFileSync('docker', ['inspect', name!], { encoding: 'utf8' }),
      ) as Array<{
        HostConfig: {
          NetworkMode: string;
          ReadonlyRootfs: boolean;
          CapDrop: string[];
          SecurityOpt: string[];
          PidsLimit: number;
          Memory: number;
          NanoCpus: number;
          Tmpfs: Record<string, string>;
        };
        Config: { User: string };
      }>;
      const container = inspected[0]!;
      expect(container.HostConfig.NetworkMode).toBe('none');
      expect(container.HostConfig.ReadonlyRootfs).toBe(true);
      expect(container.HostConfig.CapDrop).toContain('ALL');
      expect(container.HostConfig.SecurityOpt).toContain('no-new-privileges');
      expect(container.HostConfig.PidsLimit).toBe(64);
      expect(container.HostConfig.Memory).toBe(512 * 1024 * 1024);
      expect(container.HostConfig.NanoCpus).toBe(1_000_000_000);
      expect(container.HostConfig.Tmpfs['/tmp']).toContain('size=64m');
      expect(container.HostConfig.Tmpfs['/work']).toContain('size=256m');
      expect(container.Config.User).toBe('65534:65534');
    } finally {
      if (name) stopIsolatedSession(name);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('selects Docker bridge only when network is explicitly allowed', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'criteriatrace-network-'));
    let name: string | undefined;
    try {
      name = await startIsolatedSession(workspace, {
        mode: 'isolated',
        allowNetwork: true,
        image: 'node:24-alpine',
      });
      expect(name).toBeDefined();
      const network = execFileSync(
        'docker',
        ['inspect', '--format', '{{.HostConfig.NetworkMode}}', name!],
        { encoding: 'utf8' },
      ).trim();
      expect(network).toBe('bridge');
    } finally {
      if (name) stopIsolatedSession(name);
      await rm(workspace, { recursive: true, force: true });
    }
  });
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

  it('cannot reach DNS, Internet, metadata, or Docker gateway addresses', async () => {
    const script = `const dns=require('dns'),net=require('net');const targets=['1.1.1.1','169.254.169.254','172.17.0.1','192.168.1.1'];function probe(host){return new Promise(resolve=>{const s=net.connect({host,port:80});s.setTimeout(400);s.on('connect',()=>{s.destroy();resolve(host+':CONNECTED')});s.on('error',()=>resolve(host+':DENIED'));s.on('timeout',()=>{s.destroy();resolve(host+':DENIED')})})}const dnsProbe=Promise.race([new Promise(resolve=>dns.lookup('example.com',error=>resolve('DNS:'+(error?'DENIED':'RESOLVED')))),new Promise(resolve=>setTimeout(()=>resolve('DNS:DENIED'),1200))]);Promise.all([dnsProbe,...targets.map(probe)]).then(lines=>console.log(lines.join('\\n')));`;
    const result = await runInProject(['node', '-e', script]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('DNS:DENIED');
    for (const target of ['1.1.1.1', '169.254.169.254', '172.17.0.1', '192.168.1.1']) {
      expect(result.output).toContain(`${target}:DENIED`);
    }
  });

  it('cannot inspect host process environment or arguments through procfs', async () => {
    const previous = process.env.CRITERIATRACE_FAKE_SECRET;
    process.env.CRITERIATRACE_FAKE_SECRET = `CRITERIATRACE_PROC_CANARY_${Date.now()}`;
    try {
      const script = `const fs=require('fs');const proc=fs.readdirSync('/proc').filter(x=>/^\\d+$/.test(x));let leaked=false;for(const pid of proc){try{if(fs.readFileSync('/proc/'+pid+'/environ').toString().split('\\0').some(x=>x.startsWith('CRITERIATRACE_FAKE_SECRET=')))leaked=true}catch{}}console.log('PROC_HOST_LEAK:'+leaked);console.log('PROC_PIDS:'+proc.length)`;
      const result = await runInProject(['node', '-e', script]);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('PROC_HOST_LEAK:false');
      const processCount = Number(result.output.match(/PROC_PIDS:(\d+)/)?.[1]);
      expect(processCount).toBeLessThanOrEqual(4);
    } finally {
      if (previous === undefined) delete process.env.CRITERIATRACE_FAKE_SECRET;
      else process.env.CRITERIATRACE_FAKE_SECRET = previous;
    }
  });

  it('kills a persistent child and removes its container on timeout', async () => {
    const script = `require('child_process').spawn('node',['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}).unref();setInterval(()=>{},1000)`;
    const result = await runInProject(['node', '-e', script], 'isolated', 1);
    expect(result.termination).toBe('timeout');
    expect(result.workspace).toContain('removed after execution');
  });

  it('removes the exact container and detached descendants after timeout', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'criteriatrace-process-'));
    const policy = { mode: 'isolated' as const, allowNetwork: false, image: 'node:24-alpine' };
    let name: string | undefined;
    try {
      name = await startIsolatedSession(workspace, policy);
      expect(name).toBeDefined();
      const result = await executeCommand({
        id: 'descendant-timeout',
        revision: 'fixture',
        command: [
          'node',
          '-e',
          "require('child_process').spawn('node',['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}).unref();setInterval(()=>{},1000)",
        ],
        workspace,
        timeoutMs: 1000,
        outputBytes: 1024,
        policy: { ...policy, containerName: name },
      });
      expect(result.termination).toBe('timeout');
      const remaining = execFileSync(
        'docker',
        ['ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.ID}}'],
        { encoding: 'utf8' },
      );
      expect(remaining.trim()).toBe('');
    } finally {
      if (name) stopIsolatedSession(name);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('reports unavailable if the container disappears before docker exec', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'criteriatrace-vanished-'));
    const marker = join(workspace, 'host-executed');
    const policy = { mode: 'isolated' as const, allowNetwork: false, image: 'node:24-alpine' };
    let name: string | undefined;
    try {
      name = await startIsolatedSession(workspace, policy);
      expect(name).toBeDefined();
      execFileSync('docker', ['rm', '-f', name!], { stdio: 'ignore' });
      const result = await executeCommand({
        id: 'vanished-container',
        revision: 'fixture',
        command: ['node', '-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`],
        workspace,
        timeoutMs: 1000,
        outputBytes: 1024,
        policy: { ...policy, containerName: name },
      });
      expect(result.termination).toBe('unavailable');
      expect(result.exitCode).toBeNull();
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      if (name) stopIsolatedSession(name);
      await rm(workspace, { recursive: true, force: true });
    }
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
