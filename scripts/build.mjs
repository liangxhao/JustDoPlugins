import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, mkdir, writeFile, readdir, copyFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

import { discoverApps, sourceFingerprint } from './apps.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const requested = process.argv[2];
const apps = await discoverApps();
for (const name of requested ? [requested] : apps) {
  if (!apps.includes(name)) throw new Error('Unknown registered app.');
  const output = join(root, 'plugins', 'extensions', name, 'dist');
  await mkdir(output, { recursive: true });
  const browser = await build({
    absWorkingDir: root,
    entryPoints: [`plugins/extensions/${name}/app.ts`],
    bundle: true,
    write: false,
    outfile: 'app.js',
    format: 'esm',
    platform: 'browser',
    target: 'chrome132',
    minify: true,
    loader: {
      '.wasm': 'base64',
      '.woff': 'dataurl',
      '.woff2': 'dataurl',
      '.ttf': 'dataurl',
      '.svg': 'dataurl',
      '.png': 'dataurl',
    },
    define: { 'process.env.NODE_ENV': '"production"' },
    metafile: true,
  });
  const js = browser.outputFiles
    .find(file => file.path.endsWith('.js'))
    .text.replace(/<\/script/gi, '<\\/script');
  const css = (browser.outputFiles.find(file => file.path.endsWith('.css'))?.text ?? '').replace(
    /<\/style/gi,
    '<\\/style',
  );
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${name}</title><style>${css}</style></head><body><script type="module">${js}</script></body></html>`;
  if (/<(?:script|link)[^>]+(?:src|href)=["']https?:/i.test(html))
    throw new Error('External browser asset detected.');
  await writeFile(join(output, 'app.html'), html);
  const server = await build({
    absWorkingDir: root,
    entryPoints: [`plugins/extensions/${name}/server.ts`],
    outfile: join(output, 'server.cjs'),
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node24',
    banner: { js: '#!/usr/bin/env node' },
    metafile: true,
  });
  if (existsSync(join(root, 'plugins', 'extensions', name, 'extension.ts'))) {
    await build({
      absWorkingDir: root,
      entryPoints: [`plugins/extensions/${name}/extension.ts`],
      outfile: join(output, 'extension.cjs'),
      bundle: true,
      format: 'cjs',
      platform: 'node',
      target: 'node24',
      external: ['openclaw/*'],
    });
  }
  const licenses = join(output, 'licenses');
  await rm(licenses, { recursive: true, force: true });
  await mkdir(licenses, { recursive: true });
  const packages = new Map();
  for (const path of [
    ...Object.keys(browser.metafile.inputs),
    ...Object.keys(server.metafile.inputs),
  ]) {
    const normalized = path.replaceAll('\\', '/');
    const match = [...normalized.matchAll(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/g)].at(-1);
    if (!match) continue;
    const packageDir = resolve(root, normalized.slice(0, match.index + match[0].length));
    const pkg = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
    const key = `${pkg.name}@${pkg.version}`;
    if (packages.has(key)) continue;
    const notices = [];
    for (const file of await readdir(packageDir)) {
      if (/^(licen[cs]e|notice|copying)(\.|$)/i.test(file)) {
        const target = `${key.replaceAll('/', '__')}-${file}`;
        await copyFile(join(packageDir, file), join(licenses, target));
        notices.push(target);
      }
    }
    if (!notices.length) {
      // Some npm distributions only include their attribution in README / metadata.
      for (const file of await readdir(packageDir)) {
        if (!/^(readme\.(md|txt)|package\.json)$/i.test(file)) continue;
        const target = `${key.replaceAll('/', '__')}-${file}`;
        await copyFile(join(packageDir, file), join(licenses, target));
        notices.push(target);
      }
    }
    packages.set(key, { name: pkg.name, version: pkg.version, license: pkg.license, notices });
  }
  await writeFile(
    join(output, 'THIRD_PARTY_NOTICES.json'),
    JSON.stringify([...packages.values()], null, 2),
  );
  const ownLicense = require.resolve('@perspective-dev/client/package.json');
  await copyFile(join(dirname(ownLicense), 'LICENSE'), join(output, 'LICENSE')).catch(async () => {
    // Univer and Perspective both use Apache-2.0; require the full text at build time.
    await copyFile(join(root, 'node_modules/@univerjs/core/LICENSE'), join(output, 'LICENSE'));
  });
  const sourceFiles = [
    ...new Set(
      [
        ...Object.keys(browser.metafile.inputs),
        ...Object.keys(server.metafile.inputs),
        `plugins/extensions/${name}/package.json`,
        `plugins/extensions/${name}/openclaw.plugin.json`,
        'scripts/build.mjs',
        'scripts/apps.mjs',
        'package.json',
        'package-lock.json',
      ].filter(file => !file.replaceAll('\\', '/').includes('node_modules/')),
    ),
  ].sort();
  await writeFile(
    join(output, 'integrity.json'),
    JSON.stringify(
      {
        app: name,
        version: '0.1.0',
        sourceFiles,
        sourceHash: await sourceFingerprint(sourceFiles),
        assets: Object.fromEntries(
          await Promise.all(
            ['app.html', 'server.cjs'].map(async file => [
              file,
              createHash('sha256')
                .update(await readFile(join(output, file)))
                .digest('hex'),
            ]),
          ),
        ),
      },
      null,
      2,
    ),
  );
  console.log(
    `${name}: ${(Buffer.byteLength(html) / 1024 / 1024).toFixed(1)} MiB, standalone server built`,
  );
}
