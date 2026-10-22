import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  entryPoints: ['shared/loopback.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
});
const { isBrowserPortAllowed, listenLoopback } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
);

test('browser-restricted ports are rejected even on loopback', () => {
  for (const port of [0, 25, 6000, 6666, 6697, 10080, 65536, NaN])
    assert.equal(isBrowserPortAllowed(port), false);
  assert.equal(isBrowserPortAllowed(54321), true);
});

test('a blocked allocation is closed before publishing the next usable origin', async () => {
  const server = createServer((_req, res) => res.end('ready'));
  let attempts = 0;
  try {
    const origin = await listenLoopback(server, target => {
      attempts++;
      target.listen(attempts === 1 ? 6000 : 0, '127.0.0.1');
    });
    assert.ok(attempts >= 2);
    assert.notEqual(new URL(origin).port, '6000');
    assert.equal(await (await fetch(origin)).text(), 'ready');
    const released = createServer();
    await new Promise((resolve, reject) => {
      released.once('error', reject);
      released.listen(6000, '127.0.0.1', resolve);
    });
    await new Promise(resolve => released.close(resolve));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('bad allocations stop after 32 attempts and leave no listener', async () => {
  const server = createServer();
  let attempts = 0;
  await assert.rejects(
    () =>
      listenLoopback(server, target => {
        attempts++;
        target.listen(6000, '127.0.0.1');
      }),
    /32 attempts/,
  );
  assert.equal(attempts, 32);
  assert.equal(server.listening, false);
});
