import assert from 'node:assert/strict';
import { cp, mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { test } from 'node:test';
import { build } from 'esbuild';
import { table as createTable } from '@perspective-dev/client/node';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const output = await build({
  stdin: { contents: `export * from './shared/contracts.ts'; export * from './shared/analysis.ts'; export * from './plugins/extensions/perspective/data-input.ts'; export * from './plugins/extensions/perspective/arrow-input.ts';`, resolveDir: process.cwd() },
  bundle: true, platform: 'node', format: 'esm', write: false,
});
const { validateData, parseAnalysisInput, base64FromBytes, bytesFromBase64, analysisPlugins, inspectArrowInput, MAX_ARROW_BODY_BYTES } = await import(
  `data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text + '\n//# sourceURL=perspective-data-test-bundle.mjs').toString('base64')}`
);
const arrowFixtures = JSON.parse(await readFile('tests/fixtures/perspective-arrow.json', 'utf8'));

test('Perspective canonical typed values prevent silent integer and calendar coercion', () => {
  const data = validateData('perspective', {
    rows: [{ id: '001', count: 2147483647, date: '2024-02-29', time: '2024-03-01T08:30:00.123+08:00', blank: null }],
    schema: { count: 'integer', date: 'date', time: 'datetime', blank: 'float' },
    config: { filter: [['date', '>=', '2024-02-29']] },
  });
  assert.deepEqual(data.rows, [{ id: '001', count: 2147483647, date: Date.parse('2024-02-29T00:00:00Z'), time: Date.parse('2024-03-01T00:30:00.123Z'), blank: null }]);
  assert.equal(data.schema.blank, 'float');
  assert.equal(data.schema.id, 'string');
  assert.equal(data.config.filter[0][2], Date.parse('2024-02-29T00:00:00Z'));
  assert.deepEqual(validateData('perspective', data), data, 'canonical values round trip');
  for (const value of [2147483648, -2147483649, 1.5])
    assert.throws(() => validateData('perspective', { rows: [{ x: value }], schema: { x: 'integer' } }), /32-bit integer/);
  for (const value of ['2026-02-30', '2026-1-01', 1, -8640000000000000, 8640000000000000])
    assert.throws(() => validateData('perspective', { rows: [{ x: value }], schema: { x: 'date' } }), /declared type date/);
  for (const value of ['2026-02-30T00:00:00Z', '2026-01-01T00:00:00', '2026-01-01T24:00:00Z', '2026-01-01T00:00:60Z'])
    assert.throws(() => validateData('perspective', { rows: [{ x: value }], schema: { x: 'datetime' } }), /declared type datetime/);
  assert.equal(validateData('perspective', { rows: [{ x: 1 }] }).schema.x, 'float');
  assert.equal(validateData('perspective', { rows: [{ x: '2026-10-29' }] }).schema.x, 'string');
  for (const operand of [1.5, [1.5]])
    assert.throws(() => validateData('perspective', { rows: [{ x: 1 }], schema: { x: 'integer' }, config: { filter: [['x', Array.isArray(operand) ? 'in' : '==', operand]] } }), /32-bit integer/);
  for (const [x, operand] of [[1, '1'], ['one', 1], [true, 'true']])
    assert.throws(() => validateData('perspective', { rows: [{ x }], config: { filter: [['x', '==', operand]] } }), /declared type/);
});

test('Perspective parses local NDJSON, columns and JSON without losing string identifiers', async () => {
  const rows = [{ id: '001', count: 2 }, { id: '002', count: 3 }];
  const ndjson = await parseAnalysisInput({ format: 'ndjson', text: `\uFEFF${JSON.stringify(rows[0])}\n\n${JSON.stringify(rows[1])}`, schema: { count: 'integer' } });
  assert.deepEqual(ndjson.rows, rows);
  assert.equal(ndjson.schema.count, 'integer');
  assert.deepEqual((await parseAnalysisInput({ format: 'columns', text: JSON.stringify({ id: ['001', '002'], count: [2, 3] }) })).rows, rows);
  assert.deepEqual((await parseAnalysisInput({ format: 'json', text: JSON.stringify(rows) })).rows, rows);
  const blob = base64FromBytes(new TextEncoder().encode(JSON.stringify(rows)));
  assert.deepEqual((await parseAnalysisInput({ format: 'json', blob })).rows, rows);
  await assert.rejects(parseAnalysisInput({ format: 'ndjson', text: '{}\n\n{' }), /line 3/);
  await assert.rejects(parseAnalysisInput({ format: 'columns', text: '{"id":[1,2],"x":[1]}' }), /equal lengths/);
  await assert.rejects(parseAnalysisInput({ format: 'ndjson', text: '[1,2]' }), /record|object/i);
  await assert.rejects(parseAnalysisInput({ format: 'json', text: '[]', blob }), /exactly one/);
  await assert.rejects(parseAnalysisInput({ format: 'json', blob: base64FromBytes(new Uint8Array([255])) }), /encoded|encoding/i);
  await assert.rejects(parseAnalysisInput({ format: 'ndjson', text: Array.from({ length: 5001 }, () => '{"x":1}').join('\n') }), /5000/);
  await assert.rejects(parseAnalysisInput({ format: 'columns', text: JSON.stringify(Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`x${index}`, [1]]))) }), /100/);
  assert.throws(() => bytesFromBase64('abcd!'), /base64/);
});

test('Perspective Arrow imports retain logical source types and clean native resources', async () => {
  const table = await createTable({ id: 'string', count: 'integer', date: 'date', time: 'datetime', blank: 'float' });
  let view;
  try {
    await table.update([{ id: '001', count: 7, date: Date.parse('2026-10-29T00:00:00Z'), time: 1793232000123, blank: null }]);
    view = await table.view();
    {
      const arrow = await view.to_arrow();
      const parsed = await parseAnalysisInput({ format: 'arrow', blob: base64FromBytes(new Uint8Array(arrow)) }, createTable);
      assert.deepEqual(parsed.schema, { id: 'string', count: 'integer', date: 'date', time: 'datetime', blank: 'float' });
      assert.deepEqual(parsed.rows, [{ id: '001', count: 7, date: Date.parse('2026-10-29T00:00:00Z'), time: 1793232000123, blank: null }]);
    }
    const flat = await table.view({ columns: ['id', 'count', 'time', 'blank'] });
    try {
      for (const compression of ['lz4', 'zstd']) {
        await assert.rejects(parseAnalysisInput({ format: 'arrow', blob: base64FromBytes(new Uint8Array(await view.to_arrow({ compression }))) }, createTable), /export uncompressed Arrow/);
        const parsed = await parseAnalysisInput({ format: 'arrow', blob: base64FromBytes(new Uint8Array(await flat.to_arrow({ compression }))) }, createTable);
        assert.deepEqual(parsed.rows, [{ id: '001', count: 7, time: 1793232000123, blank: null }]);
        assert.equal(parsed.schema.time, 'datetime');
      }
    } finally { await flat.delete(); }
    await assert.rejects(parseAnalysisInput({ format: 'arrow', blob: base64FromBytes(new TextEncoder().encode('invalid Arrow')) }, createTable));
    const parsed = await parseAnalysisInput({ format: 'arrow', blob: base64FromBytes(new Uint8Array(await view.to_arrow())) }, createTable);
    assert.equal(parsed.rows[0].id, '001', 'valid import remains possible after a parse error');
  } finally { try { await view?.delete(); } finally { await table.delete(); } }
});

test('Perspective accepts official stream/file, dictionary and multi-batch IPC while protecting integer precision', async () => {
  for (const format of ['stream', 'file']) {
    const dictionary = await parseAnalysisInput({ format: 'arrow', blob: arrowFixtures.dictionary[format] }, createTable);
    assert.deepEqual(dictionary.rows, [{ id: '001', value: 1 }, { id: '002', value: 2 }, { id: '003', value: 3 }]);
    const multiple = await parseAnalysisInput({ format: 'arrow', blob: arrowFixtures.multibatch[format] }, createTable);
    assert.deepEqual(multiple.rows, [1, 2, 3, 4, 5].map(x => ({ x })));
    await assert.rejects(parseAnalysisInput({ format: 'arrow', blob: arrowFixtures.safe64[format] }, createTable), /32-bit integer/);
    const safe = await parseAnalysisInput({ format: 'arrow', blob: arrowFixtures.safe64[format], schema: { x: 'float' } }, createTable);
    assert.deepEqual(safe.rows, [1, 2147483647, 2147483648, 9007199254740991].map(x => ({ x })));
    for (const fixture of ['unsafe64', 'unsigned64'])
      await assert.rejects(parseAnalysisInput({ format: 'arrow', blob: arrowFixtures[fixture][format], schema: { x: 'float' } }, createTable), /exact JSON number precision/);
  }
  for (const [unit, expected] of [['second', 1001000], ['millisecond', 1001]]) {
    const temporal = await parseAnalysisInput({ format: 'arrow', blob: arrowFixtures.temporal[unit] }, createTable);
    assert.deepEqual(temporal.rows, [{ time: expected }]);
    assert.equal(temporal.schema.time, 'datetime');
  }
  const nullDate = await parseAnalysisInput({ format: 'arrow', blob: arrowFixtures.nullDate }, createTable);
  assert.deepEqual(nullDate.rows, [{ date: null }], 'unused null slots are not treated as source values');
  assert.equal(nullDate.schema.date, 'date');
});

test('Perspective rejects malformed, truncated and allocation-heavy Arrow before calling the engine', async () => {
  let allocations = 0;
  const forbidden = async () => { allocations++; throw new Error('engine must not be called'); };
  const rejectBeforeEngine = async (bytes, pattern = /Invalid Arrow input/) => {
    await assert.rejects(parseAnalysisInput({ format: 'arrow', blob: base64FromBytes(bytes) }, forbidden), pattern);
    assert.equal(allocations, 0);
  };
  const stream = bytesFromBase64(arrowFixtures.safe64.stream);
  for (const length of [1, 4, 8, 16, 64, stream.length - 9])
    await rejectBeforeEngine(stream.slice(0, length));
  const corruptRoot = stream.slice();
  new DataView(corruptRoot.buffer).setUint32(8, 0xfffffff0, true);
  await rejectBeforeEngine(corruptRoot);
  const file = bytesFromBase64(arrowFixtures.dictionary.file);
  await rejectBeforeEngine(file.slice(0, -1));
  const corruptFooter = file.slice();
  new DataView(corruptFooter.buffer).setUint32(corruptFooter.length - 10, 0xffffffff, true);
  await rejectBeforeEngine(corruptFooter);
  await rejectBeforeEngine(new Uint8Array(gunzipSync(Buffer.from(arrowFixtures.dictionaryExpansionGzip, 'base64'))), /dictionary expansion/);
  for (const unit of ['microsecond', 'nanosecond'])
    await rejectBeforeEngine(bytesFromBase64(arrowFixtures.temporal[unit]), /sub-millisecond/);
  for (const fixture of ['decimal', 'nested'])
    await rejectBeforeEngine(bytesFromBase64(arrowFixtures[fixture]), /only scalar/);
  for (const [name, fixture] of Object.entries(arrowFixtures.temporalUnsafe))
    await rejectBeforeEngine(bytesFromBase64(fixture), name.startsWith('wrappedDate') ? /UTC midnight/ : /epoch range/);

  const table = await createTable({ x: 'integer' });
  let view;
  try {
    await table.update({ x: new Array(100000).fill(1) });
    view = await table.view();
    const bomb = new Uint8Array(await view.to_arrow({ compression: 'zstd' }));
    assert.ok(bomb.length < 1024, 'tiny physical input must not bypass the row capacity');
    await rejectBeforeEngine(bomb, /5000 rows/);
    await table.replace({ x: new Array(1000).fill(1) });
    for (const [codec, magic] of [['lz4', [4, 34, 77, 24]], ['zstd', [40, 181, 47, 253]]]) {
      const bytes = new Uint8Array(await view.to_arrow({ compression: codec }));
      assert.equal(inspectArrowInput(bytes).rows, 1000);
      const frame = bytes.findIndex((_, offset) => magic.every((value, index) => bytes[offset + index] === value));
      assert.ok(frame >= 8, 'codec frame found after its declared expansion size');
      const oversized = bytes.slice();
      new DataView(oversized.buffer).setBigInt64(frame - 8, BigInt(MAX_ARROW_BODY_BYTES + 1), true);
      await rejectBeforeEngine(oversized, /capacity|16 MiB/);
      const negative = bytes.slice();
      new DataView(negative.buffer).setBigInt64(frame - 8, -2n, true);
      await rejectBeforeEngine(negative, /capacity/);
    }
  } finally { try { await view?.delete(); } finally { await table.delete(); } }
});

test('Perspective workspace owns the config mirror and rejects external bindings', () => {
  const data = validateData('perspective', { rows: [{ a: 1 }], config: { columns: ['missing'] },
    workspace: { panels: { first: { columns: ['a'] }, second: { plugin: 'Y Bar', columns: ['a'] } }, activePanel: 'second' } });
  assert.equal(data.config.plugin, 'Y Bar');
  assert.equal(data.workspace.activePanel, 'second');
  assert.equal(analysisPlugins.length, 14);
  assert.ok(!analysisPlugins.some(name => name.startsWith('Map ')));
  assert.throws(() => validateData('perspective', { rows: [{ a: 1 }], workspace: { panels: { first: { table: 'remote' } } } }), /Unrecognized/);
  assert.throws(() => validateData('perspective', { rows: [{ a: 1 }], workspace: { panels: { first: { plugin: 'Map Scatter' } } } }));
  assert.throws(() => validateData('perspective', { rows: [{ a: 1 }], config: { filter_op: 'or' } }), /AND filters only/);
});

test('Perspective packaged service imports, inspects, queries and updates all local panels', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perspective-data-service-'));
  let client;
  try {
    await cp(resolve('plugins/extensions/perspective/dist'), join(directory, 'package'), { recursive: true });
    client = new Client({ name: 'Perspective data regression', version: '1' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(directory, 'package/server.cjs')], env: { ...process.env, MCP_APP_DATA_DIR: join(directory, 'data') }, stderr: 'pipe' });
    await client.connect(transport);
    const call = async (name, input) => {
      const result = await client.callTool({ name, arguments: input });
      assert.ok(!result.isError, JSON.stringify(result));
      return result.structuredContent;
    };
    const fail = async (name, input, pattern) => {
      const result = await client.callTool({ name, arguments: input });
      assert.equal(result.isError, true, JSON.stringify(result));
      assert.match(JSON.stringify(result), pattern);
    };
    const rows = [{ id: '001', group: 'A', count: 2, day: '2026-10-29' }, { id: '002', group: 'A', count: 3, day: '2026-10-30' }, { id: '003', group: 'B', count: 4, day: '2026-10-30' }];
    const workspace = { panels: { raw: { columns: ['id', 'day', 'count'] }, summary: { plugin: 'Y Bar', group_by: ['group'], columns: ['count'], aggregates: { count: 'sum' } } }, activePanel: 'summary' };
    const created = await call('import_analysis', { title: 'Typed local data', format: 'ndjson', text: rows.map(row => JSON.stringify(row)).join('\n'), schema: { count: 'integer', day: 'date' }, workspace });
    const document = await call('read_document', { id: created.id });
    assert.equal(document.data.rows[0].id, '001');
    assert.equal(document.data.rows[0].day, Date.parse('2026-10-29T00:00:00Z'));
    assert.equal(document.data.schema.count, 'integer');
    const queried = await call('query_analysis', { id: document.id, panelId: 'summary' });
    assert.equal(queried.totalRows, 3);
    assert.equal(queried.rows[0].count, 9);
    const raw = await call('query_analysis', { id: document.id, panelId: 'raw', limit: 1, columnLimit: 1 });
    assert.equal(raw.rows[0].id, '001');
    assert.equal(raw.hasMoreRows, true);
    assert.equal(raw.hasMoreColumns, true);
    const catalog = await call('list_visualizations', {});
    assert.equal(catalog.visualizations.length, 14);
    assert.deepEqual(catalog.visualizations.find(item => item.name === 'X/Y Scatter').columns.roles.slice(0, 2), ['X Axis', 'Y Axis']);
    const inspected = await call('inspect_analysis', { id: document.id, panelId: 'summary', column: 'count', section: 'all', limit: 2 });
    assert.equal(inspected.sourceSchema.count, 'integer');
    assert.ok(inspected.styles.pluginSchema.fields.length);
    assert.ok(inspected.styles.columnSchema.fields.length);
    assert.ok(inspected.reference.windows.schema.WindowSpec);
    await fail('inspect_analysis', { id: document.id, data: document.data }, /exactly one/);
    await fail('inspect_analysis', { data: { ...document.data, workspace: { ...workspace, panels: { ...workspace.panels, hidden: { expressions: { broken: 'unknown_function(1)' }, columns: ['broken'] } } } } }, /expression|function/i);
    await fail('inspect_analysis', { data: { rows: [{ x: 1 }], schema: { x: 'integer' }, config: { expressions: { alias: '"x"' }, filter: [['alias', '==', 1.5]] } } }, /32-bit integer/);
    await fail('inspect_analysis', { data: { rows: [{ x: 1 }], workspace: { panels: {}, global_filters: [['x', 'invalid-operator', 1]] } } }, /filter|operator/i);
    await fail('configure_analysis', { id: document.id, expectedRevision: document.revision, panelId: 'missing', config: {} }, /Unknown analysis panel/);
    const replaced = await call('replace_data', { id: document.id, expectedRevision: document.revision, rows: [{ replacement: 7 }], workspace: { panels: { only: { columns: ['replacement'] } }, activePanel: 'only' } });
    assert.deepEqual((await call('read_document', { id: document.id })).data.config.columns, ['replacement']);
    const patched = await call('replace_data', { id: document.id, expectedRevision: replaced.revision, rows: [{ next: 8 }], panelId: 'only', config: { columns: ['next'] } });
    assert.deepEqual((await call('read_document', { id: document.id })).data.workspace.panels.only.columns, ['next']);
    await call('configure_workspace', { id: document.id, expectedRevision: patched.revision, workspace: { panels: {}, activePanel: null, masters: [], layout: null } });
    assert.deepEqual((await call('read_document', { id: document.id })).data.config, {});
    await fail('query_analysis', { id: document.id }, /Create a panel/);
    await call('inspect_analysis', { id: document.id });
    assert.equal((await call('list_documents', {})).documents.length, 1, 'inspection never persists documents');
    const large = await call('analyze_data', { title: 'Bounded actual query', rows: Array.from({ length: 12 }, (_, index) => ({ index, text: 'x'.repeat(32768) })) });
    await fail('query_analysis', { id: large.id, limit: 12 }, /256 KiB/);
    assert.equal((await call('query_analysis', { id: large.id, limit: 1 })).rows.length, 1,
      'the worker restarts after a result limit failure');
  } finally { await client?.close(); await rm(directory, { recursive: true, force: true }); }
});
