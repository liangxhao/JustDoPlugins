import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import perspective from '@perspective-dev/client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { assertFreshAppBuild } from '../scripts/apps.mjs';
import { listenLoopback } from './loopback-host.mjs';
import {
  normalizedOfflineRows,
  offlineNdjson,
  offlineRows,
  offlineSchema,
  offlineWorkspace,
} from './fixtures/perspective-offline.mjs';

await assertFreshAppBuild('perspective');
const requestedMotion = process.argv[2];
assert.ok(requestedMotion === undefined || ['no-preference', 'reduce'].includes(requestedMotion), 'Expected no-preference or reduce.');
const output = resolve('test-results/ui/perspective-offline');
await mkdir(output, { recursive: true });
const dataDirectory = await mkdtemp(join(tmpdir(), 'perspective-offline-'));
const client = new Client({ name: 'Offline Perspective interaction verification', version: '1' });
const host = await build({ entryPoints: ['tests/host.ts'], bundle: true, write: false, platform: 'browser', format: 'esm' });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const report = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  build: JSON.parse(await readFile('plugins/extensions/perspective/dist/integrity.json', 'utf8')).sourceHash,
  cases: [],
};
let initial, wrapper, server;

async function call(name, input = {}) {
  const result = await client.callTool({ name, arguments: input });
  assert.ok(!result.isError, JSON.stringify(result));
  return result;
}

async function eventually(read, predicate, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.fail(`${message}: ${JSON.stringify(value)}`);
}

async function inspectImage(bytes) {
  const image = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
  try {
    const canvas = new OffscreenCanvas(480, 300), context = canvas.getContext('2d');
    context.drawImage(image, 0, 0, 480, 300);
    const pixels = context.getImageData(0, 0, 480, 300).data;
    let coloredPixels = 0;
    for (let y = 45; y < 260; y++)
      for (let x = 65; x < 410; x++) {
        const index = (y * 480 + x) * 4;
        if (pixels[index + 3] > 10 && Math.max(...pixels.slice(index, index + 3)) - Math.min(...pixels.slice(index, index + 3)) > 35)
          coloredPixels++;
      }
    return { width: image.width, height: image.height, coloredPixels };
  } finally { image.close(); }
}

async function arrowRecords(bytes) {
  let table, view;
  try {
    table = await perspective.table(Uint8Array.from(bytes).buffer, { list_flatten: 'stringify' });
    view = await table.view();
    return { schema: await table.schema(), rows: await view.to_json() };
  } finally {
    try { await view?.delete(); } finally { await table?.delete(); }
  }
}

try {
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [resolve('plugins/extensions/perspective/dist/server.cjs')],
    env: { ...process.env, MCP_APP_DATA_DIR: dataDirectory },
    stderr: 'pipe',
  }));
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
        response.end(JSON.stringify(await client.callTool(JSON.parse(Buffer.concat(chunks).toString()))));
      } else if (request.url === '/') {
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><style>html,body{height:100%;margin:0}iframe{width:100%;height:100%;border:0;display:block}</style><iframe sandbox="allow-scripts allow-same-origin"></iframe><script type="module" src="/host.js"></script>');
      } else response.writeHead(404).end();
    } catch (error) { response.writeHead(500).end(String(error)); }
  });
  const origin = await listenLoopback(server);

  for (const reducedMotion of requestedMotion ? [requestedMotion] : ['no-preference', 'reduce']) {
    const result = { reducedMotion, steps: [] }, errors = [], external = [];
    let context, page;
    try {
      initial = await call('import_analysis', {
        title: `离线交互验收 ${reducedMotion}`,
        format: 'ndjson',
        text: offlineNdjson,
        schema: offlineSchema,
        config: { plugin: 'Datagrid', columns: Object.keys(offlineSchema), settings: false },
      });
      const id = initial.structuredContent.id;
      context = await browser.newContext({ viewport: { width: 1560, height: 1000 }, reducedMotion });
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.hostname === '127.0.0.1' || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
        external.push(url.href);
        return route.abort();
      });
      page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      await page.goto(origin);
      const frame = page.frameLocator('iframe').frameLocator('iframe');
      const viewer = frame.locator('perspective-viewer');
      await viewer.waitFor({ state: 'visible', timeout: 60000 });
      const ready = () => frame.locator('.title:not(:disabled)').waitFor();
      await ready();
      const raw = (name, input = {}) => page.evaluate(params => globalThis.bridge.callTool(params), { name, arguments: input });
      const live = async (name, input = {}) => {
        // Native clicks schedule context preparation. A concurrent read can
        // legitimately see BUSY; bounded read retries never replay a write.
        let conflicts = 0;
        for (let attempt = 0; attempt < 30; attempt++) {
          const response = await raw(name, input);
          const message = response.content?.[0]?.text ?? '';
          const retryable = /^BUSY:/.test(message) || (/^CONFLICT: (?:Editor changed during query|The editor changed while reading)/.test(message) && conflicts++ < 3);
          if (name !== 'analysis_apply' && response.isError && retryable && attempt < 29) {
            await new Promise(resolve => setTimeout(resolve, 100));
            continue;
          }
          assert.ok(!response.isError, `${name}: ${JSON.stringify(response)}`);
          return response.structuredContent;
        }
      };
      const snapshot = () => live('analysis_snapshot');
      const workspace = async () => (await snapshot()).workspace;
      const query = panelId => live('analysis_query', { panelId, limit: 20, columnLimit: 20 });
      const apply = async patch => {
        const current = await snapshot();
        return live('analysis_apply', { documentId: id, operationId: crypto.randomUUID(), baseContentStamp: current.contentStamp, patch });
      };
      const panelCount = async count => eventually(workspace, value => Object.keys(value.panels).length === count, `Expected ${count} panels`);
      const action = async name => {
        await frame.locator(`[data-analysis-action="${name}"]`).click();
        await ready();
      };
      await viewer.evaluate(element => {
        globalThis.originalViewer = element;
        globalThis.nativeSelections = [];
        element.addEventListener('perspective-global-filter', event => {
          const detail = event.detail;
          globalThis.nativeSelections.push({ panel: detail.panel, selected: detail.selected, insertFilters: detail.insertFilters, removeFilters: detail.removeFilters });
        });
      });
      const source = await live('analysis_inspect', { kind: 'source', offset: 0, limit: 10 });
      assert.deepEqual(source.schema, offlineSchema);
      assert.deepEqual(source.rows, normalizedOfflineRows);
      assert.equal(source.rows[0].编号, '001');
      result.steps.push('typed-source');

      await apply({ workspace: offlineWorkspace });
      assert.equal((await query('detail')).totalRows, offlineRows.length);
      const regions = viewer.locator('perspective-viewer-datagrid[slot="regions"] regular-table');
      await regions.waitFor({ state: 'visible' });
      await regions.evaluate(element => { globalThis.originalRegionTable = element; });
      const sameRegionTable = async () => assert.equal(
        await regions.evaluate(element => element === globalThis.originalRegionTable), true,
        'Unrelated manual panel operations must preserve the master Datagrid instance',
      );
      // A physical click drives the bundled plugin and native master/detail
      // listener. No synthetic selection event or direct filter restore.
      await regions.locator('td').filter({ hasText: /^华东$/ }).first().click();
      const selected = await eventually(() => query('detail'), value => value.totalRows === 3, 'A master click must filter the actual detail result');
      assert.ok(selected.rows.every(row => row.区域 === '华东'));
      assert.equal((await query('regions')).totalRows, offlineRows.length, 'A master must remain unfiltered');
      assert.deepEqual((await workspace()).global_filters, [['区域', '==', '华东']]);
      await page.screenshot({ path: join(output, `${reducedMotion}-linked.png`) });
      await action('clear-filters');
      await eventually(() => query('detail'), value => value.totalRows === offlineRows.length, 'Clearing the chip must restore detail rows');
      result.steps.push('real-click-master-detail');

      if (reducedMotion === 'no-preference') {
        await frame.locator('[data-analysis-panel]').selectOption('detail');
        await eventually(workspace, value => value.activePanel === 'detail', 'Manual panel selection must target the detail');
        const plugins = await live('analysis_inspect', { kind: 'plugins' });
        const names = plugins.visualizations.map(plugin => typeof plugin === 'string' ? plugin : plugin.name);
        assert.equal(names.length, 14);
        assert.ok(names.includes('Y Bar') && names.includes('Density') && names.includes('OHLC'));
        assert.ok(names.every(name => !name.startsWith('Map')));
        const styled = await live('analysis_inspect', { kind: 'style', panelId: 'detail', plugin: 'Y Bar', column: '数量' });
        assert.equal(styled.styles.plugin, 'Y Bar');
        assert.ok(styled.styles.pluginSchema.fields.length > 0 && styled.styles.columnSchema.fields.length > 0);
        await live('analysis_inspect', { kind: 'selection', panelId: 'regions' });
        await apply({ panelId: 'detail', config: { group_by: ['区域'], columns: ['数量'], aggregates: { 数量: 'sum' }, settings: false } });
        const stale = await snapshot();
        await frame.locator('[data-analysis-chart]').selectOption('Y Bar');
        await action('add');
        const manuallyCreated = await panelCount(3);
        await sameRegionTable();
        const manualPanel = manuallyCreated.activePanel;
        assert.equal(manuallyCreated.panels[manualPanel].plugin, 'Y Bar');
        const rejected = await raw('analysis_apply', {
          documentId: id,
          operationId: crypto.randomUUID(),
          baseContentStamp: stale.contentStamp,
          patch: { panelId: 'detail', config: { plugin: 'Y Line' } },
        });
        assert.equal(rejected.isError, true);
        assert.match(rejected.content[0].text, /CONFLICT/);
        assert.equal((await workspace()).panels[manualPanel].plugin, 'Y Bar', 'Conflict must retain the user-created chart');
        await action('close');
        await panelCount(2);
        await sameRegionTable();
        await frame.locator('[data-analysis-panel]').selectOption('detail');
        await eventually(workspace, value => value.activePanel === 'detail', 'Select the detail for export');
        await apply({ panelId: 'detail', config: { plugin: 'Y Bar' } });
        assert.equal((await workspace()).panels.detail.plugin, 'Y Bar');
        assert.equal(await viewer.evaluate(element => element === globalThis.originalViewer), true, 'Live edits must retain the viewer instance');
        const unsaved = (await call('read_document', { id })).structuredContent;
        assert.equal(unsaved.revision, 1, 'Agent and manual chart edits must not silently save');
        result.steps.push('agent-discovery-and-manual-conflict');

        // Export while a real master selection is active; PNG must not clear
        // that selection as a side effect of the native renderer's redraw.
        await regions.locator('td').filter({ hasText: /^华东$/ }).first().click();
        const linkedChart = await eventually(() => query('detail'), value => value.totalRows === 1, 'The grouped chart must contain the selected region');
        assert.deepEqual(linkedChart.rows[0].__ROW_PATH__, ['华东']);
        assert.equal(linkedChart.rows[0].数量, 25);
        await frame.locator('[data-analysis-panel]').selectOption('detail');
        await eventually(workspace, value => value.activePanel === 'detail', 'Select the filtered chart for export');
        const exportFilters = (await workspace()).global_filters;
        await viewer.evaluate(element => element.flush());
        // Capture before PNG/native export can trigger any redraw.
        await page.screenshot({ path: join(output, 'workspace.png') });
        const visibleChart = await viewer.locator('[slot="detail"]').screenshot({ path: join(output, 'detail-chart.png') });
        result.screen = await page.evaluate(inspectImage, [...visibleChart]);
        assert.ok(result.screen.coloredPixels > 50, 'The visible detail panel must contain real chart marks before export');
        const expectedRows = (await query('detail')).rows;
        const downloads = {};
        for (const format of ['csv', 'json', 'ndjson', 'arrow', 'png', 'html', 'analysis']) {
          await frame.locator('[data-export-format]').selectOption(format);
          await page.evaluate(() => { globalThis.download = undefined; });
          const calls = await page.evaluate(() => globalThis.businessCalls);
          await frame.locator('[data-action="export"]').click();
          const downloaded = await eventually(() => page.evaluate(() => globalThis.download), Boolean, `${format} must reach the host download handler`, 30000);
          await ready();
          assert.equal(await page.evaluate(() => globalThis.businessCalls), calls + 1);
          const resource = downloaded.contents[0].resource;
          assert.ok(resource.text !== undefined || resource.blob !== undefined);
          const bytes = resource.blob ? Buffer.from(resource.blob, 'base64') : Buffer.from(resource.text);
          assert.ok(bytes.length > 10, `${format} must contain exported data`);
          const extension = format === 'analysis' ? 'analysis.json' : format === 'ndjson' ? 'ndjson' : format;
          await writeFile(join(output, `result.${extension}`), bytes);
          downloads[format] = { mimeType: resource.mimeType, bytes: bytes.length };
          if (format === 'json') assert.deepEqual(JSON.parse(bytes.toString()), expectedRows);
          if (format === 'ndjson') assert.deepEqual(bytes.toString().trim().split(/\r?\n/).map(line => JSON.parse(line)), expectedRows);
          if (format === 'csv') assert.match(bytes.toString(), /数量/);
          if (format === 'html') {
            const decoded = await page.evaluate(text => {
              const document = new DOMParser().parseFromString(text, 'text/html');
              return { cells: document.querySelectorAll('td').length, script: document.querySelectorAll('script').length, text: document.body.textContent };
            }, bytes.toString());
            assert.ok(decoded.cells > 0 && decoded.text.includes(String(expectedRows[0].数量)));
            assert.equal(decoded.script, 0);
          }
          if (format === 'arrow') {
            const parsed = await arrowRecords(bytes);
            assert.equal(parsed.rows.length, expectedRows.length);
            assert.deepEqual(parsed.rows.map(row => row.数量), expectedRows.map(row => row.数量));
            downloads[format].decodedRows = parsed.rows.length;
          }
          if (format === 'png') {
            assert.equal(resource.mimeType, 'image/png');
            const image = await page.evaluate(inspectImage, [...bytes]);
            assert.ok(image.width > 200 && image.height > 150 && image.coloredPixels > 50);
            downloads[format].image = image;
          }
          if (format === 'analysis') {
            const exported = JSON.parse(bytes.toString());
            assert.deepEqual(exported.rows, normalizedOfflineRows);
            assert.deepEqual(exported.schema, offlineSchema);
            assert.equal(exported.workspace.panels.detail.plugin, 'Y Bar');
          }
          assert.deepEqual((await workspace()).global_filters, exportFilters, `${format} must preserve the active master selection`);
        }
        assert.equal((await workspace()).panels.detail.plugin, 'Y Bar');
        assert.deepEqual((await workspace()).masters, ['regions'], 'Export must not demote a master');
        result.downloads = downloads;
        result.steps.push('decoded-app-exports');
        await apply({ panelId: 'regions', config: {
          group_by: ['区域别名'], columns: ['数量'], expressions: { 区域别名: 'upper("区域")' }, aggregates: { 数量: 'sum' },
        } });
        const privateRow = regions.locator('tbody tr').filter({ hasText: '华东' }).first();
        await privateRow.locator('td').first().click();
        await frame.locator('.analysis-feedback').filter({ hasText: '点击联动仅支持源数据列' }).waitFor();
        const privateWorkspace = await live('analysis_inspect', { kind: 'workspace' });
        assert.deepEqual(privateWorkspace.workspace.global_filters, exportFilters);
        assert.equal(privateWorkspace.workspace.panels.regions.expressions.区域别名, 'upper("区域")');
        assert.deepEqual((await query('detail')).rows, expectedRows,
          'A private master expression must not poison another panel or its global filters');
        result.steps.push('private-expression-master-guard');
        await frame.locator('.title').fill('离线交互与图表');
        await frame.locator('[data-action="save"]').click();
        await frame.locator('[data-app-toolbar] #status').filter({ hasText: /^已保存$/ }).waitFor();
        const saved = (await call('read_document', { id })).structuredContent;
        assert.equal(saved.revision, 2);
        assert.deepEqual(saved.data.schema, offlineSchema);
        const beforeReload = await workspace();
        await frame.locator('[data-action="reload"]').click();
        await ready();
        assert.deepEqual(await workspace(), beforeReload);
        assert.equal((await snapshot()).dirty, false);
        assert.deepEqual((await query('detail')).rows, expectedRows);
        result.steps.push('save-and-reopen-workspace');
      }

      await regions.evaluate(element => { globalThis.originalRegionTable = element; });
      await action('add');
      await panelCount(3);
      await sameRegionTable();
      await action('duplicate');
      await panelCount(4);
      await sameRegionTable();
      await frame.locator('[data-analysis-layout]').selectOption('tabs');
      const tabbed = await eventually(workspace, value => value.layout?.type === 'tab-layout', 'Manual layout must create tabs');
      assert.equal(tabbed.layout.tabs.length, 4);
      for (let count = 3; count >= 0; count--) {
        await action('close');
        const remaining = await panelCount(count);
        if (Object.hasOwn(remaining.panels, 'regions')) await sameRegionTable();
      }
      const empty = await workspace();
      assert.equal(empty.activePanel, null);
      assert.ok(!empty.layout);
      await page.screenshot({ path: join(output, `${reducedMotion}-empty.png`) });
      await frame.locator('[data-action="save"]').click();
      await frame.locator('[data-app-toolbar] #status').filter({ hasText: /^已保存$/ }).waitFor();
      await frame.locator('[data-action="reload"]').click();
      await ready();
      await panelCount(0);
      await frame.locator('[data-analysis-chart]').selectOption('Datagrid');
      await action('add');
      const recovered = await panelCount(1);
      const newPanel = Object.keys(recovered.panels)[0];
      assert.equal((await query(newPanel)).totalRows, offlineRows.length);
      await viewer.locator('regular-table').waitFor({ state: 'visible' });
      assert.ok((await viewer.locator('regular-table').textContent()).includes('001'));
      result.steps.push('manual-panels-layout-empty-recovery');

      if (reducedMotion === 'no-preference') {
        // The separate import exercises the actual file input/parser/save path,
        // preserving identifiers instead of letting the engine infer integers.
        await frame.locator('[data-action="save"]').click();
        await frame.locator('[data-app-toolbar] #status').filter({ hasText: /^已保存$/ }).waitFor();
        await frame.locator('#file').setInputFiles({ name: 'synthetic-records.ndjson', mimeType: 'application/x-ndjson', buffer: Buffer.from(offlineNdjson) });
        await eventually(async () => (await snapshot()).documentId, value => value !== id, 'NDJSON import must create a distinct local document');
        const imported = await live('analysis_inspect', { kind: 'source', offset: 0, limit: 10 });
        assert.equal(imported.rows.length, offlineRows.length);
        assert.equal(imported.rows[0].编号, '001');
        assert.equal(imported.rows[0].更新时间, offlineRows[0].更新时间);
        result.steps.push('real-ndjson-file-import');
      }
      await page.evaluate(() => globalThis.bridge.teardownResource({}));
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      result.passed = true;
      console.log(`Perspective offline ${reducedMotion}: ${result.steps.join(', ')}`);
    } catch (error) {
      result.passed = false;
      result.error = String(error);
      result.stack = error.stack;
      if (page) result.nativeSelections = await page.frameLocator('iframe').frameLocator('iframe').locator('perspective-viewer').evaluate(() => globalThis.nativeSelections).catch(() => undefined);
      if (page) result.nativeWorkspace = await page.frameLocator('iframe').frameLocator('iframe').locator('perspective-viewer').evaluate(element => element.saveWorkspace()).catch(() => undefined);
      if (page) await page.screenshot({ path: join(output, `${reducedMotion}-failure.png`) }).catch(() => {});
      console.error(`Perspective offline ${reducedMotion}: ${result.error}`);
    } finally { await context?.close(); }
    report.cases.push({ ...result, errors, external });
  }
  await writeFile(join(output, requestedMotion ? `report-${requestedMotion}.json` : 'report.json'), JSON.stringify(report, null, 2));
  assert.ok(report.cases.every(item => item.passed), 'Offline interaction failures are recorded in the report.');
} finally {
  await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await client.close();
  assert.equal(dirname(dataDirectory), resolve(tmpdir()));
  assert.ok(basename(dataDirectory).startsWith('perspective-offline-'));
  await rm(dataDirectory, { recursive: true, force: true });
}
