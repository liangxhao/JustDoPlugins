import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const built = await build({
  entryPoints: ['plugins/univer/file-cache.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
});
const { workspaceFileCache } = await import(
  `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`
);

test('workspace snapshots are immutable, bounded, opaque and expire without persistent storage', () => {
  let time = 0;
  const cache = workspaceFileCache(() => time);
  const stageTool = cache.tools.find(tool => tool.name === 'stage_workspace_file');
  const stage = input => stageTool.run(stageTool.schema.parse(input));
  const open = token => cache.tools.find(tool => tool.name === 'open_workspace_file').run({ token });
  const token = 'a'.repeat(64);
  const data = Buffer.alloc(400 * 1024, 'x');
  const input = { token, name: '预算.xlsx', blob: data.toString('base64') };
  const descriptor = stage(input);
  assert.deepEqual(descriptor, open(token));
  assert.equal(descriptor.file.resourceUri, `app-file://${token}`);
  assert.deepEqual(
    Buffer.from(cache.readResource(descriptor.file.resourceUri).contents[0].blob, 'base64'),
    data,
  );
  assert.throws(() => stage(input), /already exists/);
  assert.throws(() => stage({ ...input, token: 'b'.repeat(64), blob: 'not base64' }), /Invalid/);
  assert.throws(() =>
    stage({
      ...input,
      token: 'b'.repeat(64),
      blob: Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64'),
    }),
  );
  for (const id of ['b', 'c', 'd', 'e']) stage({ ...input, token: id.repeat(64) });
  assert.throws(() => open(token), /expired/);
  time = 10 * 60 * 1000;
  assert.throws(() => open('e'.repeat(64)), /expired/);
  assert.equal(cache.readResource('file:///etc/passwd'), undefined);
  assert.throws(() => cache.readResource('app-file://../secret'));
});
