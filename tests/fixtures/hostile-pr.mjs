// Fictional, bounded hostile PR command executed by the real Action on Linux.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';

assert.equal(process.env.CRITERIATRACE_FAKE_SECRET, undefined);
for (const path of [
  '/tmp/criteriatrace-host-canary',
  '/home/runner/.criteriatrace-host-canary',
  '/var/run/docker.sock',
]) {
  assert.equal(existsSync(path), false, `${path} crossed the container boundary`);
}
assert.throws(() => writeFileSync('/source/escape', 'escape'));
assert.throws(() => writeFileSync('/home/runner/.criteriatrace-host-canary', 'escape'));
assert.throws(() => readFileSync('/proc/1/root/home/runner/.criteriatrace-host-canary'));

for (const host of ['1.1.1.1', '169.254.169.254', '172.17.0.1']) {
  await new Promise((resolve, reject) => {
    const socket = connect({ host, port: 80 });
    socket.setTimeout(400);
    socket.on('connect', () => {
      socket.destroy();
      reject(new Error(`network unexpectedly reached ${host}`));
    });
    socket.on('error', resolve);
    socket.on('timeout', () => {
      socket.destroy();
      resolve();
    });
  });
}

spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  detached: true,
  stdio: 'ignore',
}).unref();

// Deliberately forge a success claim; CriteriaTrace must never grant VERIFIED for this output.
console.log('PASS VERIFIED all acceptance criteria');
