import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { assertFreshAppBuild } from '../scripts/apps.mjs';
import { listenLoopback } from './loopback-host.mjs';
import { budgetColumns, budgetFormulaCells, budgetRows, sourceWorkbookFixture } from './fixtures/univer-offline.mjs';

await assertFreshAppBuild('univer');
const requested = process.argv[2];
const modes = ['document', 'reduce', 'source'];
assert.ok(!requested || modes.includes(requested), 'Expected document, reduce or source.');
const output = resolve('test-results/ui/univer-offline');
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), 'univer-offline-'));
const host = await build({ entryPoints: ['tests/host.ts'], bundle: true, write: false, platform: 'browser', format: 'esm' });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const client = new Client({ name: 'Offline Univer interaction verification', version: '1' });
const report = {
  generatedAt: new Date().toISOString(), node: process.version,
  build: JSON.parse(await readFile('plugins/extensions/univer/dist/integrity.json', 'utf8')).sourceHash,
  cases: [],
};
let server, wrapper, initial, hostContext = {}, sourceBytes;
const sourceWrites = [];
const token = 'e'.repeat(64), sourceUri = `app-file://${token}`;
const etag = () => createHash('sha256').update(sourceBytes).digest('hex');
async function call(name, input = {}) {
  const result = await client.callTool({ name, arguments: input });
  assert.ok(!result.isError, `${name}: ${JSON.stringify(result)}`);
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
const range = (r1, c1, r2 = r1, c2 = c1) => ({ startRow: r1, endRow: r2, startColumn: c1, endColumn: c2 });
async function decodeXlsx(bytes) {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(bytes);
  return book;
}

try {
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [resolve('plugins/extensions/univer/dist/server.cjs')],
    env: { ...process.env, MCP_APP_DATA_DIR: directory }, stderr: 'pipe',
  }));
  wrapper = (await client.readResource({ uri: 'ui://univer/app.html' })).contents[0].text;
  server = createServer(async (request, response) => {
    try {
      if (request.url === '/wrapper') {
        response.setHeader('Content-Type', 'text/html'); response.end(wrapper);
      } else if (request.url === '/host.js') {
        response.setHeader('Content-Type', 'text/javascript'); response.end(host.outputFiles[0].text);
      } else if (request.url === '/context') {
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(hostContext));
      } else if (request.url === '/initial') {
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(initial));
      } else if (['/tool', '/resource', '/write'].includes(request.url) && request.method === 'POST') {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const params = JSON.parse(Buffer.concat(chunks).toString());
        response.setHeader('Content-Type', 'application/json');
        if (request.url === '/tool') response.end(JSON.stringify(await client.callTool(params)));
        else if (params.uri !== sourceUri || !sourceBytes) response.writeHead(404).end();
        else if (request.url === '/resource') response.end(JSON.stringify({ contents: [{
          uri: sourceUri, blob: sourceBytes.toString('base64'), mimeType: 'application/octet-stream',
          _meta: { 'openai/resource': { writable: true, etag: etag() } },
        }] }));
        else {
          sourceWrites.push(params);
          if (params.ifMatch !== etag()) response.end(JSON.stringify({ outcome: 'conflict' }));
          else {
            sourceBytes = Buffer.from(params.blob, 'base64');
            response.end(JSON.stringify({ outcome: 'saved', etag: etag() }));
          }
        }
      } else if (request.url === '/') {
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><style>html,body{height:100%;margin:0}iframe{width:100%;height:100%;border:0;display:block}</style><iframe sandbox="allow-scripts allow-same-origin"></iframe><script type="module" src="/host.js"></script>');
      } else response.writeHead(404).end();
    } catch (error) { response.writeHead(500).end(String(error)); }
  });
  const origin = await listenLoopback(server);
  for (const mode of requested ? [requested] : modes) {
    const result = { mode, steps: [] }, errors = [], external = [];
    let context, page;
    try {
      if (mode === 'source') {
        sourceBytes = await sourceWorkbookFixture();
        await call('stage_workspace_file', { token, name: '原始预算.xlsx', blob: sourceBytes.toString('base64') });
        hostContext = { 'openai/deepLink': { url: `/workspace-file/${token}` } };
        initial = await call('open_editor');
      } else {
        hostContext = {};
        initial = await call('create_spreadsheet', { title: '离线预算', columns: budgetColumns, rows: budgetRows });
      }
      context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: mode === 'reduce' ? 'reduce' : 'no-preference' });
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.hostname === '127.0.0.1' || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
        external.push(url.href); return route.abort();
      });
      page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      await page.goto(origin);
      const frame = page.frameLocator('iframe').frameLocator('iframe');
      const canvas = frame.locator('canvas[id^="univer-sheet-main-canvas"]').first();
      await canvas.waitFor({ state: 'visible', timeout: 60000 });
      const ready = () => frame.locator('.title:not(:disabled)').waitFor();
      await ready();
      const nativeText = await frame.locator('#sheet').innerText();
      assert.ok(!/ui\.ribbon\.|sheets-ui\./.test(nativeText), 'Native spreadsheet controls must display translated labels');
      await frame.getByText('开始', { exact: true }).first().waitFor({ state: 'visible' });
      await frame.getByText('数据', { exact: true }).first().waitFor({ state: 'visible' });
      const raw = (name, input = {}) => page.evaluate(params => globalThis.bridge.callTool(params), { name, arguments: input });
      const live = async (name, input = {}) => {
        let conflicts = 0;
        for (let attempt = 0; attempt < 40; attempt++) {
          const response = await raw(name, input), message = response.content?.[0]?.text ?? '';
          const retry = /^BUSY:/.test(message) || (/^CONFLICT: (?:Editor changed during query|The editor changed while reading)/.test(message) && conflicts++ < 3);
          if (name !== 'spreadsheet_apply' && response.isError && retry && attempt < 39) {
            await new Promise(resolve => setTimeout(resolve, 100)); continue;
          }
          assert.ok(!response.isError, `${name}: ${JSON.stringify(response)}`);
          return response.structuredContent;
        }
      };
      const snapshot = () => live('spreadsheet_snapshot');
      const inspect = (kind, extra = {}) => live('spreadsheet_inspect', { kind, ...extra });
      const sheets = async () => (await inspect('sheets')).sheets;
      const query = (sheetId, r = 0, c = 0, rows = 10, columns = 10) => live('spreadsheet_query', { sheetId, startRow: r, startColumn: c, rowCount: rows, columnCount: columns });
      const inspectRange = (sheetId, selected) => inspect('range', { sheetId, range: selected });
      const apply = async operation => {
        const current = await snapshot();
        result.lastOperation = operation;
        return live('spreadsheet_apply', { documentId: current.documentId, operationId: crypto.randomUUID(), baseContentStamp: current.contentStamp, patch: { operation } });
      };
      const select = async a1 => {
        const box = frame.locator('[data-u-comp="defined-name"] input');
        await box.fill(a1); await box.press('Enter');
      };
      const keyboardUndo = async redo => {
        await canvas.click({ position: { x: 150, y: 55 } });
        await page.keyboard.press(redo ? 'Control+y' : 'Control+z');
      };
      const save = async () => {
        await frame.locator('[data-action="save"]').click();
        await ready();
      };
      const download = async format => {
        await frame.locator('[data-export-format]').selectOption(format);
        await page.evaluate(() => { globalThis.download = undefined; });
        await frame.locator('[data-action="export"]').click();
        const value = await eventually(() => page.evaluate(() => globalThis.download), Boolean, `${format} must reach the host download handler`, 30000);
        await ready();
        const resource = value.contents[0].resource;
        const bytes = resource.blob ? Buffer.from(resource.blob, 'base64') : Buffer.from(resource.text);
        assert.ok(bytes.length > 10);
        await writeFile(join(output, `${mode}.${format}`), bytes);
        return { resource, bytes };
      };
      await frame.locator('#editor').evaluate(element => { globalThis.originalUniverStage = element.firstElementChild; });
      const capabilities = await inspect('capabilities');
      assert.ok(JSON.stringify(capabilities.operations).includes('format_range') && JSON.stringify(capabilities.operations).includes('set_filter'));
      const initialSheets = await sheets(), main = initialSheets[0].id;
      const documentId = (await snapshot()).documentId;

      if (mode === 'source') {
        const originalBytes = sourceBytes, originalEtag = etag();
        await apply({ type: 'cells', sheetId: main, cells: [{ row: 1, column: 1, value: 4 }] });
        await apply({ type: 'format_range', sheetId: main, range: range(1, 0), style: { bl: 1, bg: { rgb: '#FFD166' } } });
        await apply({ type: 'format_range', sheetId: main, range: range(1, 3, 3, 3), style: { n: { pattern: '¥#,##0.000' } } });
        const beforeWrites = sourceWrites.length;
        await save();
        await eventually(() => sourceWrites.length, value => value === beforeWrites + 1, 'A supported source edit must write exactly once');
        assert.equal(sourceWrites.at(-1).ifMatch, originalEtag);
        const decoded = await decodeXlsx(sourceBytes), written = decoded.getWorksheet('原始预算');
        assert.equal(written.getCell('B2').value, 4);
        assert.equal(written.getCell('D4').result, 7400);
        assert.equal(written.getCell('A2').font.bold, true);
        assert.equal(written.getCell('A2').fill.fgColor.argb, 'FFFFD166');
        assert.equal(written.getCell('D2').numFmt, '¥#,##0.000');
        assert.equal(written.getCell('A1').fill.fgColor.argb, 'FF0F766E');
        const beforeZip = await JSZip.loadAsync(originalBytes), afterZip = await JSZip.loadAsync(sourceBytes);
        const retained = Object.keys(beforeZip.files).filter(name => /xl\/(?:media|drawings|customXml)\//.test(name) && !name.endsWith('/'));
        assert.ok(retained.length >= 3);
        for (const name of retained) assert.deepEqual(await afterZip.file(name).async('uint8array'), await beforeZip.file(name).async('uint8array'), name);
        result.steps.push('source-values-formatting-and-untouched-parts');
        await apply({ type: 'insert_rows', sheetId: main, start: 2, count: 1 });
        await save();
        await eventually(() => frame.locator('[data-app-toolbar] #status').textContent(), text => /not supported|不支持/.test(text), 'A source structural edit must show an explicit rejection');
        assert.equal(sourceWrites.length, beforeWrites + 1, 'Unsupported structure must fail before the host write');
        assert.equal((await snapshot()).dirty, true);
        await keyboardUndo(false);
        await eventually(sheets, value => value[0].rowCount === initialSheets[0].rowCount, 'Undo must restore the source structure');
        await apply({ type: 'set_filter', sheetId: main, range: range(0, 0, 2, 3) });
        await save();
        await eventually(() => frame.locator('[data-app-toolbar] #status').textContent(), text => /rule|filter|unsupported|不支持/i.test(text), 'Source rule changes must not be silently discarded');
        assert.equal(sourceWrites.length, beforeWrites + 1);
        await frame.locator('[data-action="saveCopy"]').click();
        await ready();
        const copied = await eventually(snapshot, value => value.documentId !== documentId && value.dirty === false, 'A rejected source draft must still save as a local copy');
        const copy = (await call('read_document', { id: copied.documentId })).structuredContent;
        const copyFilter = copy.data.workbook.resources.find(item => /filter/i.test(item.name));
        assert.equal(JSON.parse(copyFilter.data)[main].ref.endRow, 2);
        assert.equal(copy.data.workbook.sheets[main].cellData[1][1].v, 4);
        assert.equal(sourceWrites.length, beforeWrites + 1);
        result.steps.push('source-structure-and-rules-rejected-copy-preserved');
      } else {
        await apply({ type: 'cells', sheetId: main, cells: budgetFormulaCells });
        let values = await query(main, 1, 3, 3, 5);
        assert.equal(values.cells[0][0].value, 2500);
        assert.equal(values.cells[1][0].value, 2400);
        assert.equal(values.cells[2][0].value, 4900);
        await keyboardUndo(false);
        await eventually(() => query(main, 1, 3, 3, 5), value => value.cells[0][0].formula === undefined && value.cells[1][0].formula === undefined && value.cells[2][0].formula === undefined, 'One undo must revert the entire sparse cell operation');
        await keyboardUndo(true);
        await eventually(() => query(main, 3, 3, 1, 1), value => value.cells[0][0].value === 4900, 'One redo must restore the batch');
        await select('G2:G3');
        await page.keyboard.press('Control+d');
        const filled = await eventually(() => query(main, 1, 6, 2, 1), value => value.cells[1][0].value === 312, 'Native fill-down must calculate a relative formula');
        assert.match(filled.cells[1][0].formula, /D3\*\$H\$2/);
        result.steps.push('agent-cells-one-undo-redo-and-native-shared-formula-fill');
        await apply({ type: 'cells', sheetId: main, cells: [{ row: 0, column: 9, formula: '=IMAGE("https://example.invalid/offline.png")' }] });
        await eventually(() => query(main, 0, 9, 1, 1), value => value.cells[0][0].value === '#NAME?', 'IMAGE must remain disabled without attempting a remote load');
        await apply({ type: 'cells', sheetId: main, cells: [{ row: 0, column: 9, value: null }] });
        result.steps.push('offline-image-formula-boundary');
        await apply({ type: 'format_range', sheetId: main, range: range(0, 0, 0, 7), style: { bl: 1, fs: 12, bg: { rgb: '#0F766E' }, cl: { rgb: '#FFFFFF' } } });
        assert.equal((await inspectRange(main, range(0, 0))).styles[0][0].bl, 1);
        await keyboardUndo(false);
        await eventually(() => inspectRange(main, range(0, 0)), value => value.styles[0][0].bl !== 1, 'One undo must restore the whole header style');
        await keyboardUndo(true);
        await apply({ type: 'format_range', sheetId: main, range: range(1, 3, 3, 3), style: { n: { pattern: '¥#,##0.00' } } });
        await apply({ type: 'format_range', sheetId: main, range: range(1, 3), style: { bl: 1 } });
        assert.equal((await inspectRange(main, range(1, 3))).styles[0][0].n.pattern, '¥#,##0.00', 'A style patch must preserve the existing number format');
        await apply({ type: 'format_range', sheetId: main, range: range(1, 4, 2, 4), style: { n: { pattern: '0%' } } });
        await select('A2'); await page.keyboard.press('Control+b');
        await eventually(() => inspectRange(main, range(1, 0)), value => value.styles[0][0].bl === 1, 'Manual Ctrl+B must be observable through the agent inspector');
        const stale = await snapshot();
        await select('B2'); await page.keyboard.type('4');
        await live('prepare_context');
        const rejected = await raw('spreadsheet_apply', { documentId, operationId: crypto.randomUUID(), baseContentStamp: stale.contentStamp, patch: { operation: { type: 'cells', sheetId: main, cells: [{ row: 1, column: 1, value: 99 }] } } });
        assert.equal(rejected.isError, true); assert.match(rejected.content[0].text, /CONFLICT/);
        await eventually(() => query(main, 3, 3, 1, 1), value => value.cells[0][0].value === 7400, 'Manual input must recalculate dependent formulas before context acknowledgement');
        result.steps.push('range-formatting-native-format-and-stale-stamp');

        if (mode === 'document') {
          await apply({ type: 'add_sheet', sheetId: 'summary', name: '汇总', rowCount: 40, columnCount: 10 });
          await apply({ type: 'cells', sheetId: 'summary', cells: [{ row: 0, column: 0, formula: "='离线预算'!D4" }] });
          await apply({ type: 'rename_sheet', sheetId: main, name: '预算明细' });
          await apply({ type: 'insert_rows', sheetId: main, start: 2, count: 1 });
          await apply({ type: 'insert_columns', sheetId: main, start: 1, count: 1 });
          let summary = await query('summary', 0, 0, 1, 1);
          assert.equal(summary.cells[0][0].value, 7400); assert.match(summary.cells[0][0].formula, /预算明细.*E5/);
          const movedFormula = await query(main, 3, 7, 1, 1);
          assert.equal(movedFormula.cells[0][0].value, 312); assert.match(movedFormula.cells[0][0].formula, /E4\*\$I\$2/);
          await apply({ type: 'delete_columns', sheetId: main, start: 1, count: 1 });
          await apply({ type: 'delete_rows', sheetId: main, start: 2, count: 1 });
          summary = await query('summary', 0, 0, 1, 1);
          assert.match(summary.cells[0][0].formula, /预算明细.*D4/);
          await apply({ type: 'resize_rows', sheetId: main, start: 0, count: 1, size: 34 });
          assert.equal((await inspectRange(main, range(0, 0))).rowData[0].h, 34);
          await apply({ type: 'resize_columns', sheetId: main, start: 0, count: 1, size: 180 });
          await apply({ type: 'set_rows_hidden', sheetId: main, start: 8, count: 1, hidden: true });
          await apply({ type: 'set_columns_hidden', sheetId: main, start: 9, count: 1, hidden: true });
          const hiddenState = await inspectRange(main, range(8, 9));
          assert.equal(hiddenState.rowData[8].hd, 1, 'The live worksheet must retain the hidden empty row');
          assert.equal(hiddenState.columnData[9].hd, 1, 'The live worksheet must retain the hidden empty column');
          await apply({ type: 'freeze', sheetId: main, rows: 1, columns: 1 });
          await apply({ type: 'merge', sheetId: main, range: range(6, 0, 6, 5) });
          await apply({ type: 'cells', sheetId: main, cells: [{ row: 6, column: 0, value: '合成预算 · 仅用于离线验收' }] });
          const beforeCopy = await sheets();
          await apply({ type: 'copy_sheet', sheetId: main });
          const copied = (await sheets()).find(sheet => !beforeCopy.some(before => before.id === sheet.id));
          assert.ok(copied);
          assert.equal((await query(copied.id, 2, 6, 1, 1)).cells[0][0].value, 312);
          await apply({ type: 'set_sheet_hidden', sheetId: copied.id, hidden: true });
          await apply({ type: 'set_sheet_hidden', sheetId: copied.id, hidden: false });
          await apply({ type: 'delete_sheet', sheetId: copied.id });
          await apply({ type: 'move_sheet', sheetId: 'summary', index: 0 });
          assert.equal((await sheets())[0].id, 'summary');
          await apply({ type: 'sort_range', sheetId: main, range: range(1, 0, 2, 5), orderRules: [{ column: 2, direction: 'asc' }] });
          const sorted = await query(main, 1, 0, 2, 4);
          assert.deepEqual(sorted.cells.map(row => row[0].value), ['设备B', '设备A']);
          assert.deepEqual(sorted.cells.map(row => row[3].value), [2400, 5000]);
          result.steps.push('worksheets-row-column-structure-and-reference-rewrites');
          await apply({ type: 'cells', sheetId: 'summary', cells: [{ row: 1, column: 1, value: 123 }] });
          await apply({ type: 'format_range', sheetId: 'summary', range: range(1, 1), style: { bl: 1, bg: { rgb: '#FFD166' } } });
          await apply({ type: 'clear_range', sheetId: 'summary', range: range(1, 1), mode: 'contents' });
          let scratch = await inspectRange('summary', range(1, 1));
          assert.equal(scratch.cells[0][0].value, null); assert.equal(scratch.styles[0][0].bl, 1);
          await apply({ type: 'cells', sheetId: 'summary', cells: [{ row: 1, column: 1, value: 456 }] });
          await apply({ type: 'clear_range', sheetId: 'summary', range: range(1, 1), mode: 'formats' });
          scratch = await inspectRange('summary', range(1, 1));
          assert.equal(scratch.cells[0][0].value, 456); assert.ok(!scratch.styles[0][0].bg);
          await apply({ type: 'clear_range', sheetId: 'summary', range: range(1, 1), mode: 'all' });
          assert.equal((await query('summary', 1, 1, 1, 1)).cells[0][0].value, null);
          result.steps.push('clear-contents-formats-and-all');
          await frame.getByText('预算明细', { exact: true }).first().click();
          await eventually(snapshot, value => value.activeSheetId === main, 'Manual worksheet tab selection must target exports');
        }
        assert.equal(await frame.locator('#editor').evaluate(element => element.firstElementChild === globalThis.originalUniverStage), true);
        assert.equal((await call('read_document', { id: documentId })).structuredContent.revision, 1, 'Live changes must not silently save');
        await page.screenshot({ path: join(output, `${mode}-workbook.png`) });
        const xlsx = await download('xlsx'), decoded = await decodeXlsx(xlsx.bytes);
        const savedSheet = decoded.getWorksheet(mode === 'document' ? '预算明细' : '离线预算');
        assert.equal(savedSheet.getCell('A1').font.bold, true);
        assert.equal(savedSheet.getCell('A1').fill.fgColor.argb, 'FF0F766E');
        assert.equal(savedSheet.getCell('D2').numFmt, '¥#,##0.00');
        assert.match(savedSheet.getCell('G3').formula, /D3\*\$H\$2/);
        assert.equal(savedSheet.getCell('D4').result, 7400);
        if (mode === 'document') {
          assert.equal(savedSheet.getCell('G3').result, 650);
          // Univer dimensions use CSS pixels; OOXML row heights use points.
          assert.equal(savedSheet.getRow(1).height, 34 * 72 / 96);
          assert.equal(savedSheet.getRow(9).hidden, true, 'XLSX must retain the hidden empty row 9');
          assert.equal(savedSheet.getColumn(10).hidden, true, 'XLSX must retain the hidden empty column J');
          assert.ok(savedSheet.getCell('F7').isMerged);
          assert.equal(savedSheet.views[0].xSplit, 1); assert.equal(savedSheet.views[0].ySplit, 1);
          assert.equal(decoded.worksheets[0].name, '汇总');
          for (const format of ['csv', 'tsv']) {
            const exported = await download(format), text = exported.bytes.toString('utf8');
            assert.ok(text.includes('设备A') && text.includes('设备B') && text.includes('7400'));
            if (format === 'tsv') assert.ok(text.includes('\t'));
          }
          await apply({ type: 'set_filter', sheetId: main, range: range(0, 0, 2, 5) });
          const resources = (await inspect('resources')).resources;
          assert.ok(resources.some(item => /filter/i.test(item.name) && item.bytes > 0));
          await frame.locator('[data-export-format]').selectOption('xlsx');
          await page.evaluate(() => { globalThis.download = undefined; });
          await frame.locator('[data-action="export"]').click();
          await ready();
          await eventually(() => frame.locator('[data-app-toolbar] #status').textContent(), text => /rule|filter|unsupported|不支持/i.test(text), 'XLSX must explicitly reject unsupported rules');
          assert.equal(await page.evaluate(() => globalThis.download), undefined);
          const json = JSON.parse((await download('json')).bytes.toString());
          const filter = (json.workbook ?? json).resources.find(item => /filter/i.test(item.name));
          const actualRange = JSON.parse(filter.data)[main].ref;
          for (const [key, value] of Object.entries(range(0, 0, 2, 5))) assert.equal(actualRange[key], value);
          result.steps.push('xlsx-values-styles-shared-formulas-and-rule-export-policy');
        }
        await save();
        await frame.locator('[data-app-toolbar] #status').filter({ hasText: /^已保存$/ }).waitFor();
        const persisted = (await call('read_document', { id: documentId })).structuredContent;
        assert.equal(persisted.revision, 2);
        const child = persisted.data.workbook.sheets[main].cellData[2][6];
        assert.match(child.f, /D3\*\$H\$2/); assert.ok(!child.si, 'Saved shared-formula children must have independent formulas');
        const beforeReload = await inspect('sheets');
        await frame.locator('[data-action="reload"]').click(); await ready();
        assert.deepEqual(await inspect('sheets'), beforeReload);
        assert.equal((await snapshot()).dirty, false);
        assert.equal((await query(main, 3, 3, 1, 1)).cells[0][0].value, 7400);
        result.steps.push('save-reopen-and-materialized-formula-persistence');
      }
      await page.evaluate(() => globalThis.bridge.teardownResource({}));
      assert.deepEqual(errors, []); assert.deepEqual(external, []);
      result.passed = true;
      console.log(`Univer offline ${mode}: ${result.steps.join(', ')}`);
    } catch (error) {
      result.passed = false; result.error = String(error); result.stack = error.stack;
      if (page) await page.screenshot({ path: join(output, `${mode}-failure.png`) }).catch(() => {});
      console.error(`Univer offline ${mode}: ${result.error}`);
    } finally { await context?.close(); }
    report.cases.push({ ...result, errors, external });
  }
  await writeFile(join(output, requested ? `report-${requested}.json` : 'report.json'), JSON.stringify(report, null, 2));
  assert.ok(report.cases.every(item => item.passed), 'Univer offline failures are recorded in the report.');
} finally {
  await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await client.close();
  assert.equal(dirname(directory), resolve(tmpdir())); assert.ok(basename(directory).startsWith('univer-offline-'));
  await rm(directory, { recursive: true, force: true });
}
