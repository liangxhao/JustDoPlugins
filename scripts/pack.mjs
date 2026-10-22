import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertFreshAppBuild, discoverApps } from './apps.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'dist', 'archives', 'extensions');
const extensions = join(root, 'dist', 'plugins', 'extensions');
if (!process.env.npm_execpath) throw new Error('Run npm run pack:apps.');
await mkdir(extensions, { recursive: true });
await mkdir(output, { recursive: true });
const checksums = [];
for (const name of await discoverApps()) {
  await assertFreshAppBuild(name);
  const source = join(root, 'plugins', 'extensions', name);
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  // Publish a self-contained directory, with no workspace links or build dependencies.
  const target = resolve(extensions, name);
  assert.equal(dirname(target), extensions);
  await rm(target, { recursive: true, force: true });
  await mkdir(target);
  await cp(join(source, 'dist'), join(target, 'dist'), { recursive: true });
  await copyFile(
    join(root, 'docs', 'plugins', 'extensions', name, 'README.md'),
    join(target, 'README.md'),
  );
  for (const file of [
    'openclaw.plugin.json',
    ...(manifest.openclaw?.extensions ?? [])
      .map(file => file.replace(/^\.\//, ''))
      .filter(file => !file.startsWith('dist/')),
  ]) {
    const from = resolve(source, file);
    const to = resolve(target, file);
    assert.ok(
      !isAbsolute(file) && from.startsWith(source + sep) && to.startsWith(target + sep),
      'Extension entry must remain inside its plugin directory.',
    );
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to);
  }
  const nativeManifest = JSON.parse(await readFile(join(source, 'openclaw.plugin.json'), 'utf8'));
  for (const skill of nativeManifest.skills ?? []) {
    const from = resolve(source, skill),
      to = resolve(target, skill);
    assert.ok(
      !isAbsolute(skill) && from.startsWith(source + sep) && to.startsWith(target + sep),
      'Skill directory must remain inside its plugin directory.',
    );
    await cp(from, to, { recursive: true });
  }
  const runtimeManifest = Object.fromEntries(
    Object.entries(manifest).filter(
      ([key]) => !['devDependencies', 'scripts', 'mcpApp'].includes(key),
    ),
  );
  await writeFile(join(target, 'package.json'), JSON.stringify(runtimeManifest, null, 2) + '\n');
  const result = spawnSync(
    process.execPath,
    [process.env.npm_execpath, 'pack', '--json', '--ignore-scripts', '--pack-destination', output],
    { cwd: target, encoding: 'utf8', windowsHide: true },
  );
  if (result.status !== 0)
    throw new Error(result.stderr || result.error?.message || 'Package creation failed.');
  const [packed] = JSON.parse(result.stdout);
  const included = new Set(packed.files.map(file => file.path));
  const integrity = JSON.parse(await readFile(join(source, 'dist/integrity.json'), 'utf8'));
  for (const file of [
    'README.md',
    'package.json',
    'openclaw.plugin.json',
    'dist/app.html',
    'dist/server.cjs',
    'dist/integrity.json',
    'dist/THIRD_PARTY_NOTICES.json',
    ...Object.keys(integrity.assets).map(file => `dist/${file}`),
    ...(manifest.openclaw?.extensions ?? []).map(file => file.replace(/^\.\//, '')),
  ])
    assert.ok(included.has(file), `Missing packaged runtime file: ${file}`);
  for (const skill of nativeManifest.skills ?? []) {
    const prefix = skill.replace(/^\.\//, '').replace(/\/$/, '') + '/';
    assert.ok(
      [...included].some(file => file.startsWith(prefix) && file.endsWith('/SKILL.md')),
      `Missing packaged native skill: ${skill}`,
    );
  }
  assert.ok(
    [...included].every(file => !file.split('/').includes('node_modules')),
    'Runtime package must not contain development dependency directories.',
  );
  const hash = createHash('sha256')
    .update(await readFile(join(output, packed.filename)))
    .digest('hex');
  checksums.push(`${hash}  ${packed.filename}`);
  console.log(`${name}: import directory ${target}; archive ${packed.filename}`);
}
await writeFile(join(output, 'SHA256SUMS'), checksums.join('\n') + '\n');
