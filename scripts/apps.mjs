import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Extension App registration only; this is not OpenClaw or MCP capability metadata. */
export async function discoverApps(root = repositoryRoot) {
  const names = [];
  for (const entry of await readdir(join(root, 'plugins', 'extensions'), {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) continue;
    const directory = join(root, 'plugins', 'extensions', entry.name);
    const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    const hasUi = existsSync(join(directory, 'app.ts'));
    if (!hasUi && pkg.mcpApp === undefined) continue;
    assert.match(entry.name, /^[a-z][a-z0-9-]*$/, 'Invalid App directory name');
    assert.equal(
      pkg.mcpApp?.contractVersion,
      1,
      `${entry.name}: register mcpApp.contractVersion = 1 in package.json; App contract tests are required`,
    );
    assert.ok(
      hasUi && existsSync(join(directory, 'server.ts')),
      `${entry.name}: missing App entry files`,
    );
    names.push(entry.name);
  }
  return names.sort();
}

export async function sourceFingerprint(files, root = repositoryRoot) {
  const hash = createHash('sha256');
  for (const file of [...files].sort()) {
    const path = resolve(root, file);
    assert.ok(!isAbsolute(file) && path.startsWith(root + sep), 'Invalid App source path');
    hash
      .update(file)
      .update('\0')
      .update(await readFile(path))
      .update('\0');
  }
  return hash.digest('hex');
}

export async function assertFreshAppBuild(name, root = repositoryRoot) {
  const directory = join(root, 'plugins', 'extensions', name, 'dist');
  const manifest = JSON.parse(await readFile(join(directory, 'integrity.json'), 'utf8'));
  assert.ok(manifest.sourceFiles?.length, `${name}: rebuild the App before running tests`);
  assert.ok(
    manifest.sourceFiles.includes(`plugins/extensions/${name}/app.ts`),
    `${name}: missing App entry fingerprint`,
  );
  assert.equal(
    await sourceFingerprint(manifest.sourceFiles, root),
    manifest.sourceHash,
    `${name}: App sources changed; run npm run build before tests or packaging`,
  );
  const pkg = JSON.parse(
    await readFile(join(root, 'plugins/extensions', name, 'package.json'), 'utf8'),
  );
  const extensionFiles = (pkg.openclaw?.extensions ?? [])
    .filter(file => file.startsWith('./dist/'))
    .map(file => file.slice('./dist/'.length));
  for (const file of ['app.html', 'server.cjs', ...extensionFiles])
    assert.ok(Object.hasOwn(manifest.assets, file), `${name}: missing asset fingerprint: ${file}`);
  for (const file of Object.keys(manifest.assets)) {
    assert.ok(
      !isAbsolute(file) && resolve(directory, file).startsWith(directory + sep),
      'Invalid App asset path',
    );
    assert.equal(
      createHash('sha256')
        .update(await readFile(join(directory, file)))
        .digest('hex'),
      manifest.assets[file],
      `${name}: built App asset integrity mismatch`,
    );
  }
}
