import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { assertFreshAppBuild, discoverApps, sourceFingerprint } from '../scripts/apps.mjs';

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'app-registration-'));
  for (const type of ['extensions', 'skills', 'mcp-servers', 'hooks'])
    await mkdir(join(root, 'plugins', type), { recursive: true });
  try {
    await run(root);
  } finally {
    assert.equal(dirname(root), tmpdir());
    await rm(root, { recursive: true, force: true });
  }
}
async function plugin(root, name, pkg, ui = true, type = 'extensions') {
  const path = join(root, 'plugins', type, name);
  await mkdir(path);
  await writeFile(join(path, 'package.json'), JSON.stringify(pkg));
  if (ui)
    for (const file of ['app.ts', 'server.ts']) await writeFile(join(path, file), 'export {};');
}
test('every registered App is discovered without another test allowlist; ordinary plugins are exempt', () =>
  fixture(async root => {
    await plugin(root, 'ordinary', {}, false);
    assert.deepEqual(await discoverApps(root), []);
    await plugin(root, 'second', { mcpApp: { contractVersion: 1 } });
    await plugin(root, 'first', { mcpApp: { contractVersion: 1 } });
    assert.deepEqual(await discoverApps(root), ['first', 'second']);
  }));

test('other plugin types do not enter extension App discovery or contract checks', () =>
  fixture(async root => {
    await plugin(root, 'sample', { mcpApp: { contractVersion: 1 } });
    const skill = join(root, 'plugins/skills/instructions');
    await mkdir(skill);
    await writeFile(join(skill, 'SKILL.md'), '# Instructions');
    for (const type of ['mcp-servers', 'hooks'])
      await plugin(root, 'sample', { mcpApp: { contractVersion: 99 } }, true, type);
    assert.deepEqual(await discoverApps(root), ['sample']);
  }));

test('an unregistered UI or unsupported App contract cannot silently skip the gate', () =>
  fixture(async root => {
    await plugin(root, 'missing', {});
    await assert.rejects(() => discoverApps(root), /register mcpApp.contractVersion/);
    await writeFile(
      join(root, 'plugins/extensions/missing/package.json'),
      JSON.stringify({ mcpApp: { contractVersion: 2 } }),
    );
    await assert.rejects(() => discoverApps(root), /register mcpApp.contractVersion/);
  }));
test('stale sources and modified built assets cannot reuse an old App proof', () =>
  fixture(async root => {
    await plugin(root, 'sample', {
      mcpApp: { contractVersion: 1 },
      openclaw: { extensions: ['./dist/extension.cjs'] },
    });
    const dist = join(root, 'plugins/extensions/sample/dist');
    await mkdir(dist);
    const sourceFiles = ['plugins/extensions/sample/app.ts'];
    const assets = {};
    for (const file of ['app.html', 'server.cjs', 'extension.cjs']) {
      await writeFile(join(dist, file), file);
      assets[file] = createHash('sha256').update(file).digest('hex');
    }
    await writeFile(
      join(dist, 'integrity.json'),
      JSON.stringify({
        sourceFiles,
        sourceHash: await sourceFingerprint(sourceFiles, root),
        assets,
      }),
    );
    await assertFreshAppBuild('sample', root);
    await writeFile(join(root, sourceFiles[0]), 'export const changed = true;');
    await assert.rejects(() => assertFreshAppBuild('sample', root), /sources changed/);
    await writeFile(join(root, sourceFiles[0]), 'export {};');
    await writeFile(join(dist, 'app.html'), 'Changed UI');
    await assert.rejects(() => assertFreshAppBuild('sample', root), /asset integrity mismatch/);
    await writeFile(join(dist, 'app.html'), 'app.html');
    await writeFile(join(dist, 'extension.cjs'), 'Changed native entry');
    await assert.rejects(() => assertFreshAppBuild('sample', root), /asset integrity mismatch/);
  }));
