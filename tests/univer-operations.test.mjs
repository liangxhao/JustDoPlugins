import assert from 'node:assert/strict';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { after, test } from 'node:test';
import { build } from 'esbuild';
import { Univer, LocaleType, LogLevel } from '@univerjs/core';
import { FUniver } from '@univerjs/core/facade';
import { UniverSheetsPlugin, AutoFillCommand } from '@univerjs/sheets';
import { UniverFormulaEnginePlugin } from '@univerjs/engine-formula';
import { UniverSheetsFormulaPlugin, CalculationMode } from '@univerjs/sheets-formula';
import '@univerjs/sheets/facade';
import '@univerjs/sheets-formula/facade';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const directory = await mkdtemp(join(tmpdir(), 'univer-operations-'));
const bundle = await build({ stdin: { contents: `export * from './plugins/extensions/univer/operations.ts'; export * from './plugins/extensions/univer/operation-validator.ts';`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', write: false });
await writeFile(join(directory, 'operations.cjs'), bundle.outputFiles[0].contents);
await cp(resolve('plugins/extensions/univer/dist/operations-worker.mjs'), join(directory, 'operations-worker.mjs'));
const require = createRequire(join(directory, 'operations.cjs'));
const { normalizeSpreadsheetOperation: normalize, spreadsheetStyleSchema, materializeWorkbook, inspectSpreadsheet,
  createSpreadsheetOperationValidator, univerApplySchema, executeSpreadsheetOperation } = require('./operations.cjs');
after(async () => {
  assert.equal(dirname(directory), resolve(tmpdir()));
  assert.ok(basename(directory).startsWith('univer-operations-'));
  await rm(directory, { recursive: true, force: true });
});
function fixture() {
  return { workbook: { id: 'book', name: 'Synthetic spreadsheet', appVersion: '1.1.0', locale: 'enUS',
    styles: { base: { bl: 1, n: { pattern: '0.00' } } }, sheetOrder: ['source', 'other'], sheets: {
      source: { id: 'source', name: 'Source', rowCount: 20, columnCount: 10, cellData: {
        0: { 0: { v: 3 }, 1: { f: '=A1*2', v: 6, s: 'base' } }, 1: { 0: { v: 1 } }, 2: { 0: { v: 2 } },
      } },
      other: { id: 'other', name: 'Other', rowCount: 20, columnCount: 10, cellData: { 0: { 0: { f: '=Source!A1', v: 3 } } } },
    } } };
}
const range = { startRow: 5, endRow: 5, startColumn: 0, endColumn: 1 };
const run = async (validator, data, operation) => validator.preview(data, normalize(data.workbook, { sheetId: 'source', ...operation }));
const next = result => ({ workbook: result.workbook });

test('Univer operation schemas bound formats, targets, merges, visibility and formula metadata', () => {
  const { workbook } = fixture();
  assert.equal(univerApplySchema.parse({ sheetId: 'source', cells: [{ row: 0, column: 0, value: 4 }] }).sheetId, 'source');
  assert.throws(() => univerApplySchema.parse({ sheetId: 'source', operation: { type: 'copy_sheet', sheetId: 'source' } }), /either/);
  for (const style of [{ ff: 'url(http://invalid)' }, { bg: { rgb: 'red' } }, { fs: -1 }, { ht: 99 }, { arbitrary: true }])
    assert.equal(spreadsheetStyleSchema.safeParse(style).success, false);
  assert.throws(() => normalize(workbook, { type: 'cells', sheetId: 'source', cells: [{ row: 20, column: 0, value: 1 }] }), /bounds/);
  assert.throws(() => normalize(workbook, { type: 'merge', sheetId: 'source', range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 1 } }), /discard/);
  assert.throws(() => normalize(workbook, { type: 'rename_sheet', sheetId: 'source', name: 'other' }), /already exists/);
  assert.throws(() => normalize(workbook, { type: 'add_sheet', sheetId: '__proto__', name: 'bad' }));
  assert.throws(() => normalize(workbook, { type: 'delete_rows', sheetId: 'source', start: 0, count: 20 }), /at least one/);
  workbook.sheets.other.hidden = 1;
  assert.throws(() => normalize(workbook, { type: 'set_sheet_hidden', sheetId: 'source', hidden: true }), /visible/);
  workbook.sheets.other.hidden = 0;
  workbook.sheets.source.cellData[0][1].ft = 2;
  workbook.sheets.source.cellData[0][1].ref = 'B1:B4';
  assert.throws(() => normalize(workbook, { type: 'insert_rows', sheetId: 'source', start: 0, count: 1 }), /formula metadata/);
  assert.equal(normalize(workbook, { type: 'format_range', sheetId: 'source', range, style: { bl: 1 } }).type, 'format_range');
  workbook.sheets.source.rowData = { 0: { s: { cl: { rgb: '#ff0000' }, fs: 10 } } };
  workbook.defaultStyle = { ff: 'Inactive workbook default' };
  workbook.sheets.source.columnData = { 1: { s: { cl: { rgb: '#0000ff' }, fs: 16 } } };
  const inspected = inspectSpreadsheet(workbook, { kind: 'range', sheetId: 'source', range: { startRow: 0, endRow: 0, startColumn: 1, endColumn: 1 } });
  assert.deepEqual(inspected.styles[0][0].cl, { rgb: '#0000ff' }, 'default rendering gives column styles precedence over row styles');
  assert.equal(inspected.styles[0][0].fs, 16);
  assert.equal(inspected.styles[0][0].ff, undefined, 'the locked engine composes sheet defaults, not the unused workbook default field');
  assert.equal(inspected.styles[0][0].bl, 1, 'cell style wins after row and column defaults');
});

test('Univer materializes runtime shared formulas in a detached snapshot only', async () => {
  const univer = new Univer({ locale: LocaleType.EN_US, locales: { enUS: {} }, logLevel: LogLevel.SILENT });
  try {
    univer.registerPlugin(UniverSheetsPlugin);
    univer.registerPlugin(UniverFormulaEnginePlugin);
    univer.registerPlugin(UniverSheetsFormulaPlugin, { initialFormulaComputing: CalculationMode.NO_CALCULATION });
    const api = FUniver.newAPI(univer), book = api.createWorkbook(fixture().workbook);
    assert.equal(await api.executeCommand(AutoFillCommand.id, { unitId: 'book', subUnitId: 'source',
      sourceRange: { startRow: 0, endRow: 0, startColumn: 1, endColumn: 1 },
      targetRange: { startRow: 0, endRow: 4, startColumn: 1, endColumn: 1 }, applyType: 'COPY' }), true);
    await api.getFormula().onCalculationResultApplied(5000);
    const before = structuredClone(book.save());
    assert.ok(before.sheets.source.cellData[3][1].si);
    assert.equal(before.sheets.source.cellData[3][1].f, undefined);
    const materialized = materializeWorkbook(api);
    assert.equal(materialized.sheets.source.cellData[3][1].f, '=A4*2');
    assert.equal(materialized.sheets.source.cellData[3][1].si, undefined);
    assert.deepEqual(book.save(), before, 'read/export must preserve the live shared-formula model and undo state');
    const large = fixture().workbook;
    large.id = 'large-shared';
    large.sheets.source.rowCount = 1400;
    large.sheets.source.cellData = Object.fromEntries(Array.from({ length: 1400 }, (_, row) => [row,
      { 0: { si: 'long-group', v: 'cached', ...(row === 0 ? { f: `="${'x'.repeat(8000)}"` } : {}) } }]));
    const longBook = api.createWorkbook(large);
    assert.throws(() => materializeWorkbook(api), /Expanded shared formulas exceed 8 MiB/);
    assert.equal(longBook.save().sheets.source.cellData[1399][0].f, undefined,
      'a rejected materialization leaves the live shared group untouched');
    const inactive = fixture().workbook;
    inactive.id = 'inactive-target';
    const inactiveBook = api.createWorkbook(inactive);
    inactiveBook.setActiveSheet('other');
    for (const operation of [{ type: 'rename_sheet', name: 'New Name' },
      { type: 'insert_rows', start: 2, count: 1 }, { type: 'insert_columns', start: 1, count: 1 },
      { type: 'delete_columns', start: 1, count: 1 }, { type: 'delete_rows', start: 2, count: 1 }])
      await executeSpreadsheetOperation(api, normalize(inactiveBook.save(), { sheetId: 'source', ...operation }));
    await api.getFormula().onCalculationResultApplied(5000);
    const inactiveResult = materializeWorkbook(api);
    assert.equal(inactiveResult.sheets.source.rowCount, 20);
    assert.equal(inactiveResult.sheets.source.columnCount, 10);
    assert.equal(inactiveResult.sheets.source.cellData[0][1].f, '=A1*2');
    assert.equal(inactiveResult.sheets.other.cellData[0][0].f, "='New Name'!A1",
      'consecutive explicit targets update the intended sheet and its dependents even when another sheet is active');
  } finally { univer.dispose(); }
});

test('Univer isolated worker applies real references, styles, structure, sorting and filter resources', { timeout: 60000 }, async () => {
  const events = ['unpipe', 'error', 'close', 'finish'];
  const listenerCounts = events.map(event => process.stderr.listenerCount(event));
  const validator = createSpreadsheetOperationValidator(directory), data = fixture(), baseline = structuredClone(data);
  try {
    const edited = await run(validator, data, { type: 'cells', cells: [{ row: 0, column: 0, value: 8 }] });
    assert.equal(edited.workbook.sheets.source.cellData[0][1].v, 16);
    assert.equal(edited.workbook.sheets.other.cellData[0][0].v, 8);
    assert.deepEqual(data, baseline, 'preflight cannot mutate the supplied document');
    const formatted = await run(validator, data, { type: 'format_range', range: { startRow: 0, endRow: 0, startColumn: 1, endColumn: 1 }, style: { bg: { rgb: '#ffeecc' }, it: 1 } });
    const inspected = inspectSpreadsheet(formatted.workbook, { kind: 'range', sheetId: 'source', range: { startRow: 0, endRow: 0, startColumn: 1, endColumn: 1 } });
    assert.equal(inspected.styles[0][0].bl, 1);
    assert.equal(inspected.styles[0][0].it, 1);
    assert.deepEqual(inspected.styles[0][0].n, { pattern: '0.00' });
    assert.equal(inspected.cells[0][0].formula, '=A1*2');
    const inserted = await run(validator, data, { type: 'insert_rows', start: 0, count: 1 });
    assert.equal(inserted.workbook.sheets.source.cellData[1][1].f, '=A2*2');
    assert.equal(inserted.workbook.sheets.other.cellData[0][0].f, '=Source!A2');
    const renamed = await run(validator, next(inserted), { type: 'rename_sheet', name: 'New Name' });
    assert.equal(renamed.workbook.sheets.other.cellData[0][0].f, "='New Name'!A2");
    const removed = await run(validator, next(renamed), { type: 'delete_rows', start: 0, count: 1 });
    assert.equal(removed.workbook.sheets.other.cellData[0][0].f, "='New Name'!A1");
    const columns = await run(validator, data, { type: 'insert_columns', start: 0, count: 1 });
    assert.equal(columns.workbook.sheets.source.cellData[0][2].f, '=B1*2');
    assert.equal(columns.workbook.sheets.other.cellData[0][0].f, '=Source!B1');
    const merged = await run(validator, data, { type: 'merge', range });
    assert.deepEqual(merged.workbook.sheets.source.mergeData, [range]);
    const unmerged = await run(validator, next(merged), { type: 'unmerge', range });
    assert.deepEqual(unmerged.workbook.sheets.source.mergeData, []);
    const resized = await run(validator, data, { type: 'resize_rows', start: 1, count: 2, size: 35 });
    assert.equal(resized.workbook.sheets.source.rowData[1].h, 35);
    const hidden = await run(validator, next(resized), { type: 'set_rows_hidden', start: 1, count: 2, hidden: true });
    assert.equal(hidden.workbook.sheets.source.rowData[2].hd, 1);
    const visible = await run(validator, next(hidden), { type: 'set_rows_hidden', start: 1, count: 2, hidden: false });
    assert.equal(visible.workbook.sheets.source.rowData[1].hd, 0);
    const frozen = await run(validator, data, { type: 'freeze', rows: 1, columns: 1 });
    assert.deepEqual(frozen.workbook.sheets.source.freeze, { startRow: 1, startColumn: 1, ySplit: 1, xSplit: 1 });
    const sorted = await run(validator, data, { type: 'sort_range', range: { startRow: 0, endRow: 2, startColumn: 0, endColumn: 1 }, orderRules: [{ column: 0, direction: 'asc' }] });
    assert.deepEqual([0, 1, 2].map(r => sorted.workbook.sheets.source.cellData[r][0].v), [1, 2, 3]);
    assert.equal(sorted.workbook.sheets.source.cellData[2][1].f, '=A3*2');
    const filtered = await run(validator, data, { type: 'set_filter', range: { startRow: 0, endRow: 2, startColumn: 0, endColumn: 1 } });
    assert.ok(filtered.workbook.resources.find(resource => resource.name === 'SHEET_FILTER_PLUGIN').data.includes('source'));
    const cleared = await run(validator, next(filtered), { type: 'set_filter', range: null });
    assert.ok(!cleared.workbook.resources.find(resource => resource.name === 'SHEET_FILTER_PLUGIN').data.includes('source'));
    const added = await run(validator, data, { type: 'add_sheet', sheetId: 'new', name: 'New', index: 1, rowCount: 30, columnCount: 12 });
    assert.deepEqual(added.workbook.sheetOrder, ['source', 'new', 'other']);
    const copied = await run(validator, data, { type: 'copy_sheet' });
    assert.equal(copied.workbook.sheetOrder.length, 3);
    const copyId = copied.workbook.sheetOrder[1];
    assert.notEqual(copyId, 'source');
    assert.equal(copied.workbook.sheets[copyId].cellData[0][1].f, '=A1*2');
    const deleted = await run(validator, next(copied), { type: 'delete_sheet', sheetId: copyId });
    assert.deepEqual(deleted.workbook.sheetOrder, ['source', 'other']);
    const opaque = fixture();
    opaque.workbook.resources = [{ name: 'FUTURE_PLUGIN', data: '{"opaque":true}' }];
    const kept = await run(validator, opaque, { type: 'format_range', range, style: { bl: 1 } });
    assert.equal(kept.workbook.resources.find(resource => resource.name === 'FUTURE_PLUGIN').data, '{"opaque":true}');
    await assert.rejects(run(validator, opaque, { type: 'insert_rows', start: 1, count: 1 }), /unknown workbook resources/);
    assert.equal((await run(validator, data, { type: 'format_range', range, style: { bl: 1 } })).operation.type, 'format_range', 'a valid request follows a rejected operation');
  } finally {
    validator.close();
    assert.deepEqual(events.map(event => process.stderr.listenerCount(event)), listenerCounts,
      'repeated worker lifecycles release their stderr pipe listeners');
  }
});

test('Univer independent worker disables IMAGE at the formula engine and emits no image-loader error', { timeout: 20000 }, async () => {
  const worker = new Worker(join(directory, 'operations-worker.mjs'), { stdout: true, stderr: true });
  let stdout = '', stderr = '';
  worker.stdout.on('data', chunk => { stdout += chunk.toString(); });
  worker.stderr.on('data', chunk => { stderr += chunk.toString(); });
  try {
    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('The offline IMAGE worker did not finish.')), 15000);
      worker.once('error', error => { clearTimeout(timeout); reject(error); });
      worker.once('message', message => { clearTimeout(timeout); resolve(message); });
      worker.postMessage({ id: 1, task: 'preview', data: fixture(), operation: {
        type: 'cells', sheetId: 'source', cells: [{ row: 5, column: 0,
          formula: '=IMAGE("https://offline-test.invalid/image.png")' }],
      } });
    });
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(result.result.workbook.sheets.source.cellData[5][0].v, '#NAME?');
  } finally { await worker.terminate(); }
  assert.equal(stdout, '', 'the worker does not emit business data or image errors on stdout');
  assert.equal(stderr, '', 'the native IMAGE loader must not execute or raise Image-is-not-defined errors');
});

test('Univer worker queue cancels cold and queued requests, closes and bounds pending work', async () => {
  const validator = createSpreadsheetOperationValidator(directory), data = fixture();
  const controller = new AbortController();
  const tasks = Array.from({ length: 16 }, () => validator.preview(data,
    { type: 'cells', sheetId: 'source', cells: [{ row: 0, column: 0, value: 9 }] }, controller.signal));
  const handled = Promise.allSettled(tasks);
  await assert.rejects(validator.inspect(data, { kind: 'sheets' }), /BUSY/);
  controller.abort();
  assert.ok((await handled).every(result => result.status === 'rejected'));
  assert.equal((await validator.inspect(data, { kind: 'sheets' })).sheets.length, 2);
  validator.close();
  await assert.rejects(validator.inspect(data, { kind: 'sheets' }), /closed/);
});

test('Univer packaged MCP applies atomic revisions, bounded inspection and cancellation without writing previews', { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'univer-operations-mcp-'));
  let client;
  try {
    await cp(resolve('plugins/extensions/univer/dist'), join(root, 'package'), { recursive: true });
    client = new Client({ name: 'Univer operations regression', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, 'package/server.cjs')], env: { ...process.env, MCP_APP_DATA_DIR: join(root, 'data') }, stderr: 'pipe' }));
    const call = (name, input, options) => client.callTool({ name, arguments: input }, undefined, options);
    const ok = async (name, input) => { const result = await call(name, input); assert.ok(!result.isError, JSON.stringify(result)); return result.structuredContent; };
    const created = await ok('import_document', { title: 'Synthetic operations', data: fixture() });
    const preview = await ok('preview_spreadsheet_edit', { data: fixture(), operation: { type: 'cells', sheetId: 'source', cells: [{ row: 0, column: 0, value: 9 }] } });
    assert.equal(preview.validated, true);
    assert.equal(preview.workbook, undefined);
    assert.equal((await ok('read_document', { id: created.id })).revision, 1);
    const results = await Promise.all([4, 5].map(value => call('edit_spreadsheet', { id: created.id, expectedRevision: 1,
      operation: { type: 'cells', sheetId: 'source', cells: [{ row: 0, column: 0, value }] } })));
    assert.equal(results.filter(result => result.isError).length, 1, 'one concurrent CAS writer wins');
    const before = await ok('read_document', { id: created.id });
    assert.equal(before.revision, 2);
    const inspected = await ok('inspect_spreadsheet', { id: created.id, kind: 'range', sheetId: 'source', range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 1 } });
    assert.equal(inspected.cells[0][1].value, before.data.workbook.sheets.source.cellData[0][0].v * 2);
    assert.equal(inspected.styles[0][1].bl, 1);
    const controller = new AbortController();
    const pending = call('edit_spreadsheet', { id: created.id, expectedRevision: 2,
      operation: { type: 'cells', sheetId: 'source', cells: [{ row: 0, column: 0, value: 99 }] } }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    await assert.rejects(pending);
    const after = await ok('read_document', { id: created.id });
    assert.deepEqual(after, before, 'cancellation before cold preflight cannot change the saved revision');
    assert.equal((await ok('list_documents', {})).documents.length, 1, 'previews never persist');
  } finally {
    await client?.close();
    assert.equal(dirname(root), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('univer-operations-mcp-'));
    await rm(root, { recursive: true, force: true });
  }
});
