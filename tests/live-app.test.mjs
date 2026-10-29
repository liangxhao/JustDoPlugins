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
  `data:text/javascript;base64,${Buffer.from(`${bundle.outputFiles[0].text}\n//# sourceURL=live-app-test-bundle.mjs`).toString('base64')}`
);

function fixture(options = {}) {
  const tools = new Map();
  let edits = 0,
    version = 0,
    generation = 1,
    closed = false,
    synchronizations = 0,
    saves = 0,
    savedVersion = 0;
  let failSync = false,
    failApply = false,
    syncHook,
    describeHook,
    beforeCaptureHook,
    savingHook,
    afterSaveHook,
    failSave = false,
    failSnapshot = false;
  const locks = [];
  let persistedData;
  let data = { rows: [{ count: 1 }], config: {} };
  let document = { id: crypto.randomUUID(), kind: options.kind ?? 'perspective', revision: 1, title: 'Data' };
  const editor = {
    async snapshot() {
      if (failSnapshot) throw new Error('Snapshot unavailable');
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
      return options.textContext === false ? {} : { updateModelContext: { text: {} } };
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
    kind: options.kind ?? 'perspective',
    applySchema: api.analysisConfigSchema.pick({ group_by: true }),
    // A bare config patch suffices to exercise generic lifecycle and stamp validation.
    state() {
      if (closed) throw new Error('Closed');
      return {
        document,
        editor,
        title: 'Data',
        dirty: version !== savedVersion,
        generation,
        editVersion: version,
      };
    },
    async exclusive(run, lockInput) {
      locks.push(lockInput);
      return run();
    },
    async commit() {},
    changed() {
      version++;
    },
    notice() {},
    ...(options.syncContext ? { syncContext: options.syncContext } : {}),
    ...(options.withSave ? { async save(mode, beforeSave) {
      await beforeCaptureHook?.();
      await beforeSave();
      const capturedVersion = version;
      const captured = structuredClone(data);
      saves++;
      await savingHook?.();
      if (failSave) throw new Error('Persistence result unknown. Do not replay.');
      const saved = { id: mode === 'copy' ? crypto.randomUUID() : document.id,
        title: document.title, revision: mode === 'copy' ? 1 : document.revision + 1,
        etag: 'must-not-leak', resourceUri: 'app-file://private-token' };
      persistedData = captured;
      if (mode === 'document') {
        document = { ...document, revision: saved.revision };
        savedVersion = capturedVersion;
      }
      await afterSaveHook?.();
      return { status: mode === 'copy' ? 'copied' : 'saved', savedDocument: saved };
    } } : {}),
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
    source(writable = false) {
      document.sourceFile = { name: 'Source.xlsx', resourceUri: 'app-file://private-token', etag: 'private-etag', writable };
    },
    rawEdit() { data.rows[0].count++; },
    beforeCapture(hook) { beforeCaptureHook = hook; },
    duringSave(hook) { savingHook = hook; },
    afterSave(hook) { afterSaveHook = hook; },
    failSave() { failSave = true; },
    failSnapshot() { failSnapshot = true; },
    saves: () => saves,
    locks: () => locks,
    persistedData: () => persistedData,
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

async function operationInput(f, prefix = 'analysis') {
  const { structuredContent: snapshot } = await f.call(`${prefix}_snapshot`);
  return {
    operationId: crypto.randomUUID(),
    documentId: snapshot.documentId,
    baseContentStamp: snapshot.contentStamp,
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

test('saving is opt-in for both live tool families and returns safe persistence metadata', async () => {
  assert.equal(fixture().tools.has('analysis_save'), false);
  for (const [kind, prefix] of [['perspective', 'analysis'], ['univer', 'spreadsheet']]) {
    const f = fixture({ kind, withSave: true });
    const tool = f.tools.get(`${prefix}_save`);
    assert.equal(tool.config.annotations.readOnlyHint, false);
    f.edit();
    const input = await operationInput(f, prefix);
    assert.equal(tool.config.inputSchema.parse(input).mode, 'document');
    assert.throws(() => tool.config.inputSchema.parse({ ...input, mode: 'source' }));
    assert.throws(() => tool.config.inputSchema.parse({ ...input, resourceUri: 'private' }));
    const saved = await f.call(`${prefix}_save`, input);
    assert.equal(saved.isError, undefined);
    assert.equal(saved.structuredContent.status, 'saved');
    assert.deepEqual(saved.structuredContent.savedDocument, {
      id: f.identity, title: 'Data', revision: 2,
    });
    assert.equal(saved.structuredContent.snapshot.revision, 2);
    assert.equal(saved.structuredContent.snapshot.dirty, false);
    assert.equal(f.saves(), 1);
    assert.equal(f.edits(), 0, 'Saving must not recreate or modify the editor');
    assert.deepEqual(f.locks(), [true, false]);
    assert.doesNotMatch(JSON.stringify(saved), /private-token|must-not-leak|etag|resourceUri/);
  }
});

test('save revalidates document, generation and complete content after pending input capture', async () => {
  for (const change of ['document', 'generation', 'edit', 'raw', 'pending', 'closed']) {
    const f = fixture({ withSave: true });
    const input = await operationInput(f);
    if (change === 'document') input.documentId = crypto.randomUUID();
    if (change === 'generation') f.reload();
    if (change === 'edit') f.edit();
    if (change === 'raw') f.rawEdit();
    if (change === 'pending') f.beforeCapture(() => f.edit());
    if (change === 'closed') f.close();
    const saved = await f.call('analysis_save', input);
    assert.equal(saved.isError, true, change);
    assert.equal(f.saves(), 0, change);
    assert.equal(f.persistedData(), undefined, change);
  }
});

test('source-file live saves require explicit local copies even with writable authorization', async () => {
  for (const writable of [false, true]) {
    const f = fixture({ withSave: true });
    f.source(writable);
    const input = await operationInput(f);
    const rejected = await f.call('analysis_save', input);
    assert.equal(rejected.isError, true);
    assert.match(rejected.content[0].text, /mode=copy/);
    assert.equal(f.saves(), 0);
    const copied = await f.call('analysis_save', { ...input, mode: 'copy' });
    assert.equal(copied.structuredContent.status, 'copied');
    assert.notEqual(copied.structuredContent.savedDocument.id, f.identity);
    assert.equal(copied.structuredContent.savedDocument.revision, 1);
    assert.equal(copied.structuredContent.snapshot.documentId, f.identity);
    assert.equal(f.saves(), 1, 'Rejected source saves must not reserve or dispatch a copy');
    assert.doesNotMatch(JSON.stringify(copied), /private-token|private-etag|must-not-leak|etag|resourceUri/);
  }
});

test('saving acknowledges the captured version while later edits remain dirty', async () => {
  const f = fixture({ withSave: true });
  f.edit();
  const input = await operationInput(f);
  f.duringSave(() => {
    f.rawEdit();
    f.edit();
  });
  const saved = await f.call('analysis_save', input);
  assert.equal(saved.structuredContent.status, 'saved');
  assert.equal(saved.structuredContent.savedDocument.revision, 2);
  assert.equal(f.persistedData().rows[0].count, 1);
  assert.equal(saved.structuredContent.snapshot.preview[0].count, 2);
  assert.equal(saved.structuredContent.snapshot.dirty, true);
  assert.equal(f.locks().at(-1), false, 'Network persistence must not lock subsequent human input');
});

test('an unknown save result cannot be replayed through save or apply', async () => {
  const f = fixture({ withSave: true });
  const input = await operationInput(f);
  f.failSave();
  const unknown = await f.call('analysis_save', input);
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /unknown/);
  const fresh = await operationInput(f);
  const replay = { ...fresh, operationId: input.operationId };
  assert.equal((await f.call('analysis_save', replay)).isError, true);
  assert.equal((await f.call('analysis_apply', { ...replay, patch: {} })).isError, true);
  assert.equal(f.saves(), 1);
  assert.equal(f.edits(), 0);
});

test('confirmed persistence remains successful if a later snapshot fails or the editor closes', async () => {
  for (const action of ['snapshot', 'close']) {
    const f = fixture({ withSave: true });
    const input = await operationInput(f);
    f.afterSave(() => action === 'snapshot' ? f.failSnapshot() : f.close());
    const saved = await f.call('analysis_save', input);
    assert.equal(saved.isError, undefined);
    assert.equal(saved.structuredContent.status, 'saved');
    assert.equal(saved.structuredContent.savedDocument.revision, 2);
    assert.equal(saved.structuredContent.snapshotUnavailable, true);
    assert.equal(saved.structuredContent.snapshot, undefined);
    assert.equal(f.saves(), 1);
    assert.equal((await f.call('analysis_save', input)).isError, true);
    assert.equal(f.saves(), 1);
  }
});

test('apply and save share the bounded operation reservation', async () => {
  const f = fixture({ withSave: true });
  let input = await operationInput(f);
  for (let i = 0; i < 127; i++) {
    const applied = await f.call('analysis_apply', { ...input, operationId: `edit-${i}`, patch: {} });
    assert.equal(applied.structuredContent.status, 'applied');
    input.baseContentStamp = applied.structuredContent.snapshot.contentStamp;
  }
  const saved = await f.call('analysis_save', { ...input, operationId: 'save-128' });
  assert.equal(saved.structuredContent.status, 'saved');
  const excess = await f.call('analysis_save', {
    ...input, operationId: 'save-129', baseContentStamp: saved.structuredContent.snapshot.contentStamp,
  });
  assert.equal(excess.isError, true);
  assert.match(excess.content[0].text, /Reopen/);
  assert.equal(f.saves(), 1);
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

test('the optional serialized context channel receives a live guard and preserves host capability checks', async () => {
  let calls = 0;
  let guard;
  const f = fixture({
    async syncContext(value, unchanged) {
      calls++;
      assert.equal(value.documentId, f.identity);
      assert.ok(Buffer.byteLength(api.contextText(value)) <= 16000);
      assert.equal(unchanged(), true);
      guard = unchanged;
    },
  });
  assert.equal((await f.call('prepare_context')).structuredContent.prepared, true);
  assert.equal(calls, 1);
  assert.equal(f.synchronizations(), 0);
  f.reload();
  assert.equal(guard(), false, 'A queued synchronization must detect document replacement');

  let changed;
  changed = fixture({ async syncContext(_value, unchanged) {
    changed.edit();
    assert.equal(unchanged(), false);
  } });
  assert.equal((await changed.call('prepare_context')).isError, true);
  const unsupported = fixture({ textContext: false, async syncContext() { calls++; } });
  assert.equal((await unsupported.call('prepare_context')).isError, true);
  assert.equal(calls, 1);
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
