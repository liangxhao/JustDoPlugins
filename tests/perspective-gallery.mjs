import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { assertFreshAppBuild } from '../scripts/apps.mjs';
import { listenLoopback } from './loopback-host.mjs';
import { galleryCases, excludedPlugins } from './fixtures/perspective-gallery.mjs';

await assertFreshAppBuild('perspective');
const requested = process.argv[2];
const cases = requested ? galleryCases.filter(item => item.id === requested) : galleryCases;
assert.ok(cases.length, 'Unknown gallery case. Use a fixture ID from perspective-gallery.mjs.');
const output = resolve('test-results/ui/perspective-gallery');
await mkdir(output, { recursive: true });
const dataDirectory = await mkdtemp(join(tmpdir(), 'perspective-gallery-'));
const client = new Client({ name: 'Perspective gallery verification', version: '1' });
const host = await build({
  entryPoints: ['tests/host.ts'],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'esm',
});
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const report = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  build: JSON.parse(await readFile('plugins/extensions/perspective/dist/integrity.json', 'utf8'))
    .sourceHash,
  coverage: requested
    ? 'One selected non-map renderer.'
    : 'All non-map renderers; not the entire upstream feature set.',
  fixtureIds: cases.map(item => item.id),
  excluded: excludedPlugins.map(plugin => ({
    plugin,
    reason: 'Online map tiles are outside this offline plugin contract.',
  })),
  cases: [],
};
let initial, wrapper, server;
const call = async (name, input = {}) => {
  const result = await client.callTool({ name, arguments: input });
  assert.ok(!result.isError, JSON.stringify(result));
  return result;
};

// Inspect the actual screenshot, not a plugin name or an export alone. Ignore
// the edges containing axes/legends so those cannot disguise an empty plot.
async function inspectPixels(bytes) {
  const image = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
  try {
    const canvas = new OffscreenCanvas(480, 300),
      context = canvas.getContext('2d');
    context.drawImage(image, 0, 0, 480, 300);
    const pixels = context.getImageData(0, 0, 480, 300).data;
    let centerColor = 0;
    for (let y = 60; y < 260; y++)
      for (let x = 65; x < 400; x++) {
        const offset = (y * 480 + x) * 4;
        if (
          pixels[offset + 3] > 10 &&
          Math.max(...pixels.slice(offset, offset + 3)) -
            Math.min(...pixels.slice(offset, offset + 3)) >
            35
        )
          centerColor++;
      }
    return { width: image.width, height: image.height, centerColor };
  } finally {
    image.close();
  }
}

try {
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [resolve('plugins/extensions/perspective/dist/server.cjs')],
      env: { ...process.env, MCP_APP_DATA_DIR: dataDirectory },
      stderr: 'pipe',
    }),
  );
  wrapper = (await client.readResource({ uri: 'ui://perspective/app.html' })).contents[0].text;
  server = createServer(async (request, response) => {
    try {
      if (request.url === '/wrapper') {
        response.setHeader('Content-Type', 'text/html');
        response.end(wrapper);
      } else if (request.url === '/host.js') {
        response.setHeader('Content-Type', 'text/javascript');
        response.end(host.outputFiles[0].text);
      } else if (request.url === '/context') {
        response.setHeader('Content-Type', 'application/json');
        response.end('{}');
      } else if (request.url === '/initial') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(initial));
      } else if (request.url === '/tool' && request.method === 'POST') {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        response.setHeader('Content-Type', 'application/json');
        response.end(
          JSON.stringify(await client.callTool(JSON.parse(Buffer.concat(chunks).toString()))),
        );
      } else if (request.url === '/') {
        response.setHeader('Content-Type', 'text/html');
        response.end(
          '<!doctype html><style>html,body{height:100%;margin:0}iframe{width:100%;height:100%;border:0;display:block}</style><iframe sandbox="allow-scripts allow-same-origin"></iframe><script type="module" src="/host.js"></script>',
        );
      } else response.writeHead(404).end();
    } catch (error) {
      response.writeHead(500).end(String(error));
    }
  });
  const origin = await listenLoopback(server);
  for (const fixture of cases) {
    const errors = [],
      external = [];
    let context, page;
    const result = {
      id: fixture.id,
      plugin: fixture.plugin,
      title: fixture.title,
      sourceRows: fixture.rows.length,
    };
    try {
      initial = await call('analyze_data', {
        title: fixture.title,
        rows: fixture.rows,
        config: fixture.config,
      });
      const id = initial.structuredContent.id;
      await writeFile(
        join(output, `${fixture.id}.json`),
        JSON.stringify({ rows: fixture.rows, config: fixture.config }, null, 2),
      );
      context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.hostname === '127.0.0.1' || ['data:', 'blob:'].includes(url.protocol))
          return route.continue();
        external.push(url.href);
        return route.abort();
      });
      page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => {
        if (message.type() === 'error') errors.push(message.text());
      });
      await page.goto(origin);
      const frame = page.frameLocator('iframe').frameLocator('iframe');
      const viewer = frame.locator('perspective-viewer');
      await viewer.waitFor({ state: 'visible', timeout: 60000 });
      await frame.locator('.title:not(:disabled)').waitFor();
      const plugins = await viewer.evaluate(element =>
        element.getAllPlugins().map(plugin => plugin.get_static_config().name),
      );
      assert.deepEqual(
        [...plugins].sort(),
        galleryCases.map(item => item.plugin).sort(),
      );
      const live = async (name, input = {}) => {
        const response = await page.evaluate(params => globalThis.bridge.callTool(params), {
          name,
          arguments: input,
        });
        assert.ok(!response.isError, JSON.stringify(response));
        return response.structuredContent;
      };
      const before = await live('analysis_snapshot');
      assert.equal(before.documentId, id);
      assert.equal(before.config.plugin, fixture.plugin);
      const query = await live('analysis_query', { limit: 10, columnLimit: 10 });
      assert.ok(
        query.totalRows > 0 && query.rows.length > 0,
        'A configured chart must have actual query results',
      );
      if (fixture.plugin === 'Datagrid') {
        assert.equal(
          query.rows[0]['产量'],
          fixture.rows.reduce((total, row) => total + row['产量'], 0),
        );
        await viewer.locator('regular-table').waitFor({ state: 'visible' });
        assert.ok((await viewer.locator('regular-table').textContent()).includes('产量'));
      }
      // Drive the real App save path and reopen, rather than only calling the
      // renderer's restore() directly with an unpersisted configuration.
      await frame.locator('.title').fill(`${fixture.title} · 演示数据`);
      await frame.locator('[data-action="save"]').click();
      await frame.locator('.title:not(:disabled)').waitFor();
      assert.equal(await frame.locator('[data-app-toolbar] #status').textContent(), '已保存');
      const persisted = (await call('read_document', { id })).structuredContent;
      assert.equal(persisted.revision, 2);
      assert.equal(persisted.data.config.plugin, fixture.plugin);
      assert.equal(persisted.data.rows.length, fixture.rows.length);
      await frame.locator('[data-action="reload"]').click();
      await frame.locator('.title:not(:disabled)').waitFor();
      const restored = await live('analysis_snapshot');
      assert.equal(restored.config.plugin, fixture.plugin);
      assert.equal(restored.dirty, false);
      const after = await live('analysis_query', { limit: 10, columnLimit: 10 });
      assert.deepEqual(after.rows, query.rows);
      assert.equal(after.totalRows, query.totalRows);
      await viewer.evaluate(element => element.flush());
      await page.screenshot({ path: join(output, `${fixture.id}-app.png`) });
      const screenshot = await viewer.screenshot({ path: join(output, `${fixture.id}.png`) });
      result.screen = await page.evaluate(inspectPixels, [...screenshot]);
      assert.ok(result.screen.width > 900 && result.screen.height > 500);
      if (fixture.plugin !== 'Datagrid')
        assert.ok(
          result.screen.centerColor > 75,
          'The actual on-screen plot must contain colored data marks',
        );
      const exported = await viewer.evaluate(async element => {
        const value = await element.export({ method: 'plugin' });
        if (typeof value === 'string') return { type: 'text', text: value };
        if (!(value instanceof Blob)) throw new Error('Unexpected plugin export type.');
        return { type: value.type, bytes: Array.from(new Uint8Array(await value.arrayBuffer())) };
      });
      if (fixture.plugin === 'Datagrid') {
        assert.equal(exported.type, 'text');
        assert.ok(exported.text.length > 10);
        await writeFile(join(output, `${fixture.id}-export.txt`), exported.text);
      } else {
        assert.equal(exported.type, 'image/png');
        result.export = await page.evaluate(inspectPixels, exported.bytes);
        assert.ok(result.export.centerColor > 75);
        await writeFile(join(output, `${fixture.id}-export.png`), Buffer.from(exported.bytes));
      }
      await frame.locator('[data-action="export"]').click();
      await frame.locator('.title:not(:disabled)').waitFor();
      const download = await page.evaluate(() => globalThis.download);
      const text = download?.contents?.[0]?.resource?.text;
      assert.ok(
        typeof text === 'string' && text.length > 10,
        'The App CSV export must return real result data',
      );
      await writeFile(join(output, `${fixture.id}.csv`), text);
      result.savedAndReloaded = true;
      result.queryRows = after.totalRows;
      result.csv = true;
      await page.evaluate(() => globalThis.bridge.teardownResource({}));
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      result.passed = true;
      console.log(`${fixture.plugin}: rendered, saved, reopened, queried and exported`);
    } catch (error) {
      result.passed = false;
      result.error = String(error);
      if (page)
        await page.screenshot({ path: join(output, `${fixture.id}-failure.png`) }).catch(() => {});
      console.error(`${fixture.plugin}: ${result.error}`);
    } finally {
      await context?.close();
    }
    report.cases.push({ ...result, errors, external });
  }
  await writeFile(
    join(output, requested ? `report-${requested}.json` : 'report.json'),
    JSON.stringify(report, null, 2),
  );
  assert.ok(
    report.cases.every(item => item.passed),
    'Gallery failures are recorded in the report.',
  );
  if (!requested) {
    const escape = text =>
      text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
    const cards = cases.map(
      item =>
        `<article><div class="caption"><strong>${escape(item.title)}</strong><span>${escape(item.plugin)}</span></div><a href="${item.id}-app.png"><img src="${item.id}.png" alt="${escape(item.title)}"></a><p>${escape(item.note)}</p><footer><a href="${item.id}-app.png">完整界面</a> · <a href="${item.id}.json">演示 JSON</a> · <a href="${item.id}.csv">结果 CSV</a></footer></article>`,
    );
    const sections = [];
    for (let offset = 0; offset < cards.length; offset += 6)
      sections.push(
        `<section class="sheet"><header><div><small>OPENCLAW EXTENSION / REAL APPLICATION CAPTURES</small><h1>Perspective · ${offset === 0 ? '图表与透视' : offset === 6 ? '多维与层级分析' : 'OHLC 与蜡烛图'}</h1><p>真实渲染 · 保存重开 · 查询与导出已验证 ｜ 全部使用合成演示数据</p></div><b>${String(offset + 1).padStart(2, '0')}–${String(Math.min(offset + 6, cards.length)).padStart(2, '0')} / ${cards.length}</b></header><main>${cards.slice(offset, offset + 6).join('')}</main></section>`,
      );
    await writeFile(
      join(output, 'index.html'),
      `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Perspective 真实效果图集</title><style>*{box-sizing:border-box}body{margin:0;background:#e8edf4;color:#18253a;font:14px system-ui,'Microsoft YaHei',sans-serif}.sheet{width:1800px;padding:30px 34px 32px;margin:auto}header{display:flex;justify-content:space-between;align-items:center;padding:0 4px 20px}small{font-size:12px;letter-spacing:2px;color:#61748f}h1{font-size:32px;margin:8px 0}header p{color:#52657f;margin:8px 0}header b{font-size:22px;color:#61748f}main{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px}article{overflow:hidden;background:#fff;border:1px solid #d9e1ec;border-radius:12px;box-shadow:0 4px 18px #18253a08}.caption{padding:14px 16px 10px;display:flex;justify-content:space-between;align-items:center}.caption strong{font-size:19px}.caption span{color:#5c6f8a;font-size:13px}img{width:100%;height:302px;object-fit:contain;display:block;border-block:1px solid #eef1f5}article p{padding:0 16px;margin:12px 0 8px;font-size:14px;color:#52657f}footer{padding:0 16px 14px;font-size:12px}a{color:#3d63b7;text-decoration:none}</style>${sections.join('')}</html>`,
    );
    // Compose a contact sheet in the browser from the unmodified App captures.
    // The separate full-size images above remain available beside this overview.
    const galleryPage = await browser.newPage({ viewport: { width: 1800, height: 1100 } });
    try {
      await galleryPage.route('https://gallery.invalid/**', async route => {
        const file = basename(new URL(route.request().url()).pathname) || 'index.html';
        const bytes = await readFile(join(output, file));
        await route.fulfill({
          body: bytes,
          contentType: file.endsWith('.png') ? 'image/png' : 'text/html',
        });
      });
      await galleryPage.goto('https://gallery.invalid/index.html');
      await galleryPage
        .locator('img')
        .evaluateAll(images => Promise.all(images.map(image => image.decode())));
      for (let i = 0; i < sections.length; i++)
        await galleryPage
          .locator('.sheet')
          .nth(i)
          .screenshot({ path: join(output, `overview-${i + 1}.png`) });
    } finally {
      await galleryPage.close();
    }
    console.log(`Gallery: ${output}/index.html (${report.cases.length} verified renderers)`);
  } else console.log(`Verified ${requested}; the complete gallery index is unchanged.`);
} finally {
  await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await client.close();
  assert.equal(dirname(dataDirectory), resolve(tmpdir()));
  assert.ok(basename(dataDirectory).startsWith('perspective-gallery-'));
  await rm(dataDirectory, { recursive: true, force: true });
}
