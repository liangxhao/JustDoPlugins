import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'dist', 'archives');
const extensions = join(root, 'dist', 'plugins');
if (!process.env.npm_execpath) throw new Error('Run npm run pack:apps.');
await mkdir(extensions, { recursive: true });
await mkdir(output, { recursive: true });
const checksums = [];
for (const name of ['univer', 'perspective']) {
  const source = join(root, 'plugins', name);
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  const integrity = JSON.parse(await readFile(join(source, 'dist/integrity.json'), 'utf8'));
  for (const file of ['server.cjs', 'app.html']) {
    assert.equal(
      createHash('sha256')
        .update(await readFile(join(source, 'dist', file)))
        .digest('hex'),
      integrity.assets[file],
      'Build complete assets before packaging.',
    );
  }
  // Publish a self-contained directory, with no workspace links or build dependencies.
  const target = resolve(extensions, name);
  assert.equal(dirname(target), extensions);
  await rm(target, { recursive: true, force: true });
  await mkdir(target);
  await cp(join(source, 'dist'), join(target, 'dist'), { recursive: true });
  await copyFile(join(root, 'docs', 'plugins', name, 'README.md'), join(target, 'README.md'));
  for (const file of ['openclaw.plugin.json', ...(name === 'perspective' ? ['extension.cjs'] : [])])
    await copyFile(join(source, file), join(target, file));
  const runtimeManifest = Object.fromEntries(
    Object.entries(manifest).filter(([key]) => !['devDependencies', 'scripts'].includes(key)),
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
  const hash = createHash('sha256')
    .update(await readFile(join(output, packed.filename)))
    .digest('hex');
  checksums.push(`${hash}  ${packed.filename}`);
  console.log(`${name}: import directory ${target}; archive ${packed.filename}`);
}
await writeFile(join(output, 'SHA256SUMS'), checksums.join('\n') + '\n');
