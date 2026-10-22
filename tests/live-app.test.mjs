import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  stdin: {
    contents: `export * from './shared/live-app'; export * from './shared/analysis';
    export * from './shared/contracts'; export * from './shared/spreadsheet';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
});
const api = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
);

function fixture() {
  const tools = new Map();
  let edits = 0,
    version = 0,
    generation = 1,
    closed = false,
    synchronizations = 0;
  let failSync = false,
    failApply = false,
    syncHook,
    describeHook;
  let data = { rows: [{ count: 1 }], config: {} };
  const document = { id: crypto.randomUUID(), kind: 'perspective', revision: 1, title: 'Data' };
  const editor = {
    async snapshot() {
      return structuredClone(data);
    },
    async describe() {
      describeHook?.();
      return { preview: data.rows, config: data.config };
    },
    async apply(patch, unchanged) {
      if (!unchanged()) throw new Error('Changed before apply');
      edits++;
      if (failApply) throw new Error('Lost application response');
      data.config = { ...data.config, ...patch.config };
    },
  };
  const app = {
    registerTool(name, config, handler) {
      tools.set(name, { config, handler });
    },
    getHostCapabilities() {
      return { updateModelContext: { text: {} } };
    },
    async updateModelContext(params) {
      synchronizations++;
      assert.ok(Buffer.byteLength(params.content[0].text) <= 16000);
      JSON.parse(params.content[0].text);
      syncHook?.();
      if (failSync) throw new Error('Context denied');
    },
  };
  const registered = api.registerLiveTools(app, {
    kind: 'perspective',
    applySchema: api.analysisConfigSchema.pick({ group_by: true }),
    // A bare config patch suffices to exercise generic lifecycle and stamp validation.
    state() {
      if (closed) throw new Error('Closed');
      return {
        document,
        editor,
        title: 'Data',
        dirty: version > 0,
        generation,
        editVersion: version,
      };
    },
    async exclusive(run) {
      return run();
    },
    async commit() {},
    changed() {
      version++;
    },
    notice() {},
  });
  return {
    tools,
    registered,
    async call(name, input = {}) {
      const { config, handler } = tools.get(name);
      return handler(config.inputSchema.parse(input));
    },
    identity: document.id,
    edit() {
      version++;
    },
    reload() {
      generation++;
    },
    close() {
      closed = true;
    },
    failSync() {
      failSync = true;
    },
    failApply() {
      failApply = true;
    },
    duringSync(hook) {
      syncHook = hook;
    },
    duringDescribe(hook) {
      describeHook = hook;
    },
    edits: () => edits,
    synchronizations: () => synchronizations,
  };
}

test('live tools expose opt-in preparation and wait for real context synchronization', async () => {
  const f = fixture();
  assert.equal(f.tools.get('prepare_context').config._meta['workspace/prepare-context'], true);
  assert.equal(f.tools.get('analysis_apply').config.annotations.readOnlyHint, false);
  const prepared = await f.call('prepare_context');
  assert.equal(prepared.structuredContent.prepared, true);
  assert.equal(f.synchronizations(), 1);
  assert.equal(f.edits(), 0);
  f.failSync();
  assert.equal((await f.call('prepare_context')).isError, true);
});

test('live stamps reject local edits, other documents, generations, and closed editors', async () => {
  const f = fixture();
  const snap = (await f.call('analysis_snapshot')).structuredContent;
  const input = {
    operationId: 'operation',
    documentId: f.identity,
    baseContentStamp: snap.contentStamp,
    patch: {},
  };
  assert.equal(
    (await f.call('analysis_apply', { ...input, documentId: crypto.randomUUID() })).isError,
    true,
  );
  f.edit();
  assert.equal((await f.call('analysis_apply', input)).isError, true);
  const current = (await f.call('analysis_snapshot')).structuredContent;
  f.reload();
  assert.equal(
    (await f.call('analysis_apply', { ...input, baseContentStamp: current.contentStamp })).isError,
    true,
  );
  assert.equal(f.edits(), 0);
  f.close();
  assert.equal((await f.call('analysis_snapshot')).isError, true);
});

test('an applied or unknown operation cannot be replayed with a new snapshot', async () => {
  for (const unknown of [false, true]) {
    const f = fixture();
    if (unknown) f.failApply();
    const before = (await f.call('analysis_snapshot')).structuredContent;
    const input = {
      operationId: 'operation',
      documentId: f.identity,
      baseContentStamp: before.contentStamp,
      patch: {},
    };
    const response = await f.call('analysis_apply', input);
    assert.equal(Boolean(response.isError), unknown);
    if (!unknown) assert.equal(response.structuredContent.status, 'applied');
    const current = (await f.call('analysis_snapshot')).structuredContent;
    assert.equal(
      (await f.call('analysis_apply', { ...input, baseContentStamp: current.contentStamp }))
        .isError,
      true,
    );
    assert.equal(f.edits(), 1);
  }
});

test('editing during context synchronization cannot be acknowledged as prepared', async () => {
  const f = fixture();
  f.duringSync(() => f.edit());
  const response = await f.call('prepare_context');
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /CONFLICT/);
});

test('editing after snapshot creation cannot reset the context preparation guard', async () => {
  const f = fixture();
  f.duringDescribe(() => queueMicrotask(() => queueMicrotask(() => f.edit())));
  const response = await f.call('prepare_context');
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /CONFLICT/);
  assert.equal(f.synchronizations(), 0, 'A stale snapshot must not be published');
});

test('context is bounded valid JSON even for wide Unicode data', () => {
  const text = api.contextText({
    documentId: 'document',
    title: '标题',
    config: { filter: [['x', 'in', Array(5000).fill('秘密')]] },
    schema: Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => ['列'.repeat(120) + i, 'string']),
    ),
    preview: Array(100).fill('数'.repeat(32768)),
  });
  assert.ok(Buffer.byteLength(text) <= 16000);
  assert.equal(JSON.parse(text).documentId, 'document');
});

test('analysis validation uses all rows, rejects mixed types and external table rebinding', () => {
  assert.deepEqual(api.analysisSchema([{ a: null }, { a: 3000000000, b: '001' }]), {
    a: 'float',
    b: 'string',
  });
  assert.throws(() => api.validateData('perspective', { rows: [{ a: 1 }, { a: '2' }] }), /mixed/);
  assert.throws(() =>
    api.validateData('perspective', { rows: [{ a: 1 }], config: { table: 'other' } }),
  );
  assert.throws(
    () => api.validateData('perspective', { rows: [{ a: 1 }], config: { group_by: ['missing'] } }),
    /Unknown/,
  );
});

test('sparse analysis columns never read inherited object properties as values', () => {
  const rows = [{ constructor: 1, toString: 'a' }, {}];
  assert.deepEqual(api.analysisSchema(rows), { constructor: 'float', toString: 'string' });
  assert.equal(api.analysisValue(rows[1], 'constructor'), null);
  assert.equal(api.analysisValue(rows[1], 'toString'), null);
  assert.equal(api.analysisValue(rows[0], 'constructor'), 1);
});

test('analysis rejects reserved source and expression columns and unbundled plugins', () => {
  for (const name of ['__INDEX__', '__ROW_PATH__']) {
    assert.throws(() => api.analysisSchema([{ [name]: 1 }]), /Reserved analysis column/);
    assert.throws(
      () => api.validateAnalysisConfig({ expressions: { [name]: '1' } }, [{ x: 1 }]),
      /Reserved analysis column/,
    );
  }
  assert.throws(() => api.analysisConfigSchema.parse({ plugin: 'unavailable-plugin' }));
  for (const plugin of api.analysisPlugins)
    assert.equal(api.analysisConfigSchema.parse({ plugin }).plugin, plugin);
});

test('declared analysis types preserve cleared columns and reject incompatible values', () => {
  const data = api.validateData('perspective', {
    rows: [{ amount: null }],
    schema: { amount: 'float' },
    config: { aggregates: { amount: 'sum' } },
  });
  assert.deepEqual(data.schema, { amount: 'float' });
  assert.deepEqual(api.analysisSchema([{ amount: null, added: true }], data.schema), {
    amount: 'float',
    added: 'boolean',
  });
  assert.throws(
    () =>
      api.validateData('perspective', {
        rows: [{ amount: '1' }],
        schema: { amount: 'float' },
      }),
    /declared type/,
  );
  assert.throws(
    () =>
      api.validateData('perspective', {
        rows: [],
        schema: { __INDEX__: 'float' },
      }),
    /Reserved/,
  );
});

test('the persisted analysis size includes its normalized schema', () => {
  const data = { rows: Array.from({ length: 64 }, () => ({ x: 'x'.repeat(32768) })), config: {} };
  const excess = Buffer.byteLength(JSON.stringify(data)) - (api.MAX_DOCUMENT_BYTES - 1);
  data.rows.at(-1).x = data.rows.at(-1).x.slice(0, 32768 - excess);
  assert.equal(Buffer.byteLength(JSON.stringify(data)), api.MAX_DOCUMENT_BYTES - 1);
  assert.throws(() => api.validateData('perspective', data), /after normalization/);
});

test('spreadsheet updates preserve metadata and reject ambiguous duplicate cells', () => {
  const workbook = api.createWorkbook('Book', ['Column'], [[1]]);
  workbook.sheets.sheet1.cellData[1][0] = { v: 1, f: '=1', s: 'currency', custom: { x: 1 } };
  api.updateCells(
    workbook,
    'sheet1',
    api.cellEditsSchema.parse([{ row: 1, column: 0, value: '=literal' }]),
  );
  assert.deepEqual(workbook.sheets.sheet1.cellData[1][0], {
    v: '=literal',
    t: 1,
    s: 'currency',
    custom: { x: 1 },
  });
  assert.throws(
    () =>
      api.cellEditsSchema.parse([
        { row: 1, column: 0, value: 2 },
        { row: 1, column: 0, formula: '=3' },
      ]),
    /once/,
  );
  assert.throws(
    () =>
      api.validateData('univer', { workbook: { ...workbook, sheetOrder: ['sheet1', 'sheet1'] } }),
    /unique/,
  );
});
