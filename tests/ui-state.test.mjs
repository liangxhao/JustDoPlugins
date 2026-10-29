import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

// Exercise the real shared App lifecycle with a small editor. Real Univer and
// Perspective behavior is covered separately by the browser checks.
const bundle = await build({
  stdin: {
    contents: `import {mountApp} from './shared/ui'; import {z} from 'zod';
globalThis.startFixture = () => mountApp('Univer', async (container, changed) => {
  container.append(document.createElement('fixture-editor-lifetime'));
  const input = document.createElement('input'); input.dataset.editor = '';
  container.append(input); let model = '';
  input.oninput = () => {
    if (!globalThis.draftOnly) { model = input.value; changed(); }
  };
  return {
    async load(doc) {
      if (globalThis.failNextLoad) { globalThis.failNextLoad = false; throw new Error('Fixture load failure'); }
      model = input.value = doc.data.workbook.sheets.sheet1.cellData[0][0].v;
    },
    async commitEdit() {
      globalThis.commitLocks.push(container.inert === true);
      if (model !== input.value) { model = input.value; changed(); }
    },
    async snapshot() {
      if (globalThis.failSnapshots) throw new Error('Fixture snapshot failure');
      globalThis.snapshotCount++;
      if (globalThis.holdSnapshot || (globalThis.queueMode && globalThis.snapshotCount === 2)) {
        globalThis.holdSnapshot = false;
        await new Promise(resolve => globalThis.releaseSnapshot = resolve);
      }
      return {workbook:{id:'book',sheetOrder:['sheet1'],sheets:{sheet1:{
        id:'sheet1',rowCount:2,columnCount:2,cellData:{0:{0:{v:model,t:1}}}
      }}}};
    },
    async describe() {
      const selection = globalThis.selectedCell;
      if (globalThis.holdDescription) {
        globalThis.holdDescription = false;
        await new Promise(resolve => globalThis.releaseDescription = resolve);
      }
      if (globalThis.queueMode && !globalThis.scheduled) {
        globalThis.scheduled = true;
        const next = n => queueMicrotask(() => n ? next(n - 1) : globalThis.startConcurrent());
        next(globalThis.queueDelay);
      }
      return {selection};
    },
    async apply() {},
    async exportFile() { return {text:'',extension:'csv',mimeType:'text/csv'}; },
    async dispose() {}
  };
}, {kind:'univer',spreadsheet:true,accept:'.csv',applySchema:z.object({}),async importFile(){return {};}});`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  platform: 'browser',
  format: 'iife',
  write: false,
  loader: { '.css': 'empty' },
  plugins: [
    {
      name: 'fixture-transport',
      setup(builder) {
        builder.onResolve({ filter: /app-presentation$/ }, () => ({
          path: 'fixture',
          namespace: 'transport',
        }));
        builder.onLoad({ filter: /.*/, namespace: 'transport' }, () => ({
          contents:
            'export const createApp=()=>globalThis.fixtureApp; export const applySharedHeader=()=>{};',
          loader: 'js',
        }));
      },
    },
  ],
});
const until = async predicate => {
  for (let i = 0; i < 300; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error('Fixture did not reach the expected state.');
};
async function fixture({ draftOnly = false, queueMode = false, queueDelay = 3, contextEnabled = false, holdDescription = false } = {}) {
  const dom = new JSDOM('<!doctype html>', { url: 'http://127.0.0.1', runScripts: 'outside-only' });
  const w = dom.window;
  w.TextEncoder = TextEncoder;
  w.TextDecoder = TextDecoder;
  Object.defineProperty(w, 'crypto', { value: crypto });
  Object.assign(w, {
    draftOnly,
    queueMode,
    queueDelay,
    snapshotCount: 0,
    commitLocks: [],
    readSecond: 0,
    disconnectedEditors: 0,
    selectedCell: 'A1',
    holdDescription,
    sharedContexts: [],
  });
  w.customElements.define(
    'fixture-editor-lifetime',
    class extends w.HTMLElement {
      disconnectedCallback() {
        w.disconnectedEditors++;
      }
    },
  );
  const original = {
    id: crypto.randomUUID(),
    kind: 'univer',
    title: 'Original',
    revision: 1,
    updatedAt: '',
    data: {
      workbook: {
        id: 'book',
        sheetOrder: ['sheet1'],
        sheets: {
          sheet1: {
            id: 'sheet1',
            rowCount: 2,
            columnCount: 2,
            cellData: { 0: { 0: { v: 'before', t: 1 } } },
          },
        },
      },
    },
  };
  const second = { ...original, id: crypto.randomUUID(), title: 'Second' };
  const tools = new Map();
  let concurrent;
  w.fixtureApp = {
    registerTool(name, config, handler) {
      tools.set(name, handler);
    },
    getHostCapabilities() {
      return contextEnabled ? { updateModelContext: { text: {} } } : {};
    },
    getHostContext() {
      return { locale: 'zh-CN' };
    },
    async connect() {},
    async updateModelContext(params) {
      w.sharedContexts.push(JSON.parse(params.content[0].text));
    },
    async callServerTool({ name, arguments: input }) {
      if (name === 'new_document') {
        w.createdDocuments = (w.createdDocuments ?? 0) + 1;
        const { data, ...reference } = second;
        return { structuredContent: structuredClone(reference) };
      }
      if (name === 'read_document') {
        if (input.id === second.id) {
          w.readSecond++;
          if (w.holdReadSecond) await new Promise(resolve => (w.releaseRead = resolve));
        }
        return { structuredContent: structuredClone(input.id === second.id ? second : original) };
      }
      if (name === 'import_document' || name === 'save_document') {
        w.saving = true;
        await new Promise(resolve => (w.releaseSave = resolve));
        w.persisted = {
          ...original,
          id: input.id ?? crypto.randomUUID(),
          revision: input.id ? 2 : 1,
          title: input.title,
          data: input.data,
        };
        return { structuredContent: structuredClone(w.persisted) };
      }
      throw new Error(name);
    },
  };
  w.startConcurrent = () => {
    concurrent = tools.get('spreadsheet_snapshot')({});
  };
  w.eval(bundle.outputFiles[0].text);
  w.startFixture();
  w.fixtureApp.ontoolresult({ structuredContent: { id: original.id, revision: 1 } });
  await until(
    () =>
      w.document.querySelector('[data-editor]')?.value === 'before' &&
      !w.document.querySelector('.title').disabled,
  );
  return {
    w,
    tools,
    second,
    concurrent: () => concurrent,
    async close() {
      w.releaseSnapshot?.();
      w.releaseSave?.();
      w.releaseRead?.();
      w.releaseDescription?.();
      await w.fixtureApp.onteardown();
      w.close();
    },
  };
}

for (const action of ['save', 'saveCopy']) {
  for (const draftOnly of [false, true]) {
    test(`${action} preserves ${draftOnly ? 'uncommitted' : 'committed'} input made while waiting`, async () => {
      const f = await fixture({ draftOnly }),
        { w } = f;
      try {
        w.document.querySelector(`[data-action="${action}"]`).click();
        await until(() => w.saving);
        const input = w.document.querySelector('[data-editor]');
        assert.notEqual(
          input.parentElement.inert,
          true,
          'Canvas stays editable during the save request',
        );
        input.value = 'after';
        input.dispatchEvent(new w.Event('input', { bubbles: true }));
        w.releaseSave();
        await until(() => !w.document.querySelector('.title').disabled);
        assert.equal(w.persisted.data.workbook.sheets.sheet1.cellData[0][0].v, 'before');
        assert.equal(w.document.querySelector('[data-editor]').value, 'after');
        assert.match(w.document.querySelector('#status').textContent, /未保存/);
        assert.ok(
          w.commitLocks.every(Boolean),
          'Capture and finalization must commit with input locked',
        );
      } finally {
        await f.close();
      }
    });
  }
}

test('live reads lock editor input before committing and release it after asynchronous capture', async () => {
  const f = await fixture({ draftOnly: true }),
    { w, tools } = f;
  try {
    const input = w.document.querySelector('[data-editor]');
    input.value = 'draft';
    w.holdSnapshot = true;
    const reading = tools.get('spreadsheet_snapshot')({});
    await until(() => w.releaseSnapshot);
    assert.equal(input.parentElement.inert, true);
    assert.equal(w.commitLocks.at(-1), true);
    w.releaseSnapshot();
    const result = await reading;
    assert.ok(!result.isError);
    assert.notEqual(input.parentElement.inert, true);
    assert.equal(result.structuredContent.dirty, true);
  } finally {
    await f.close();
  }
});

test('incoming documents survive another operation acquiring the editor after idle resolves', async () => {
  // Different promise depths ensure the notification waits on both the first
  // operation and a newly acquired operation, including the old loss window.
  for (let queueDelay = 0; queueDelay < 8; queueDelay++) {
    const f = await fixture({ queueMode: true, queueDelay }),
      { w, tools } = f;
    try {
      const first = tools.get('spreadsheet_snapshot')({});
      w.fixtureApp.ontoolresult({ structuredContent: { id: f.second.id, revision: 1 } });
      await new Promise(resolve => setTimeout(resolve, 20));
      w.releaseSnapshot?.();
      await first;
      await f.concurrent();
      await until(() => w.document.querySelector('.title').value === 'Second');
      assert.equal(w.readSecond, 1);
    } finally {
      await f.close();
    }
  }
});

test('a staged editor stays connected when it replaces the previous document', async () => {
  const f = await fixture(),
    { w } = f;
  try {
    assert.equal(
      w.disconnectedEditors,
      0,
      'Initial presentation must not tear down the new renderer',
    );
    w.fixtureApp.ontoolresult({ structuredContent: { id: f.second.id, revision: 1 } });
    await until(() => w.document.querySelector('.title').value === 'Second');
    assert.equal(w.disconnectedEditors, 1, 'Only the previous editor may disconnect');
  } finally {
    await f.close();
  }
});

test('navigation locks the old editor between leave confirmation and the arriving document', async () => {
  const f = await fixture(),
    { w } = f;
  try {
    const originalInput = w.document.querySelector('[data-editor]');
    w.holdReadSecond = true;
    w.fixtureApp.ontoolresult({ structuredContent: { id: f.second.id, revision: 1 } });
    await until(() => w.releaseRead);
    assert.equal(
      originalInput.parentElement.inert,
      true,
      'No new draft may be lost during navigation',
    );
    w.releaseRead();
    await until(() => w.document.querySelector('.title').value === 'Second');
    assert.notEqual(w.document.querySelector('[data-editor]').parentElement.inert, true);
  } finally {
    await f.close();
  }
});

test('a late background description cannot replace explicitly prepared context after a selection change', async () => {
  const f = await fixture({ contextEnabled: true, holdDescription: true }), { w, tools } = f;
  try {
    await until(() => w.releaseDescription);
    w.selectedCell = 'B2';
    const prepared = await tools.get('prepare_context')({});
    assert.ok(!prepared.isError);
    assert.equal(w.sharedContexts.length, 1);
    assert.equal(w.sharedContexts[0].selection, 'B2');
    assert.equal(w.sharedContexts[0].contentStamp, prepared.structuredContent.contentStamp);
    w.releaseDescription();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(w.sharedContexts.length, 1, 'The old A1 summary must not overwrite a confirmed B2 preparation');
  } finally { await f.close(); }
});

test('a confirmed copy reports its failed opening while retaining the previous editor', async () => {
  const f = await fixture(), { w, tools } = f;
  try {
    const before = (await tools.get('spreadsheet_snapshot')({})).structuredContent;
    const saving = tools.get('spreadsheet_save')({ operationId: 'copy-open', documentId: before.documentId,
      baseContentStamp: before.contentStamp, mode: 'copy' });
    await until(() => w.saving);
    w.failNextLoad = true;
    w.releaseSave();
    const result = await saving;
    assert.ok(!result.isError);
    assert.equal(result.structuredContent.status, 'copied');
    assert.notEqual(result.structuredContent.savedDocument.id, before.documentId);
    assert.equal(result.structuredContent.snapshot.documentId, before.documentId);
    assert.equal(w.document.querySelector('[data-editor]').value, 'before');
    assert.equal(w.document.querySelector('#status').classList.contains('error'), true);
    assert.match(w.document.querySelector('#status').textContent, /副本已保存/);
    assert.equal(w.document.querySelector('.title').disabled, false);
  } finally { await f.close(); }
});

test('manual creation resolves a view reference without replaying the creation tool', async () => {
  const f = await fixture(), { w, tools } = f;
  try {
    w.document.querySelector('[data-action="new"]').click();
    await until(() => w.document.querySelector('.title').value === 'Second' && !w.document.querySelector('.title').disabled);
    assert.equal(w.createdDocuments, 1);
    assert.equal(w.readSecond, 1);
    const current = (await tools.get('spreadsheet_snapshot')({})).structuredContent;
    assert.equal(current.documentId, f.second.id);
    assert.equal(current.dirty, false);
  } finally { await f.close(); }
});

test('live save permits later uncommitted typing and reports that draft as still unsaved', async () => {
  const f = await fixture({ draftOnly: true }), { w, tools } = f;
  try {
    const before = (await tools.get('spreadsheet_snapshot')({})).structuredContent;
    const saving = tools.get('spreadsheet_save')({ operationId: 'live-save-draft', documentId: before.documentId,
      baseContentStamp: before.contentStamp });
    await until(() => w.saving);
    const input = w.document.querySelector('[data-editor]');
    assert.notEqual(input.parentElement.inert, true, 'Live saving must release the canvas during persistence');
    input.value = 'later draft';
    input.dispatchEvent(new w.Event('input', { bubbles: true }));
    w.releaseSave();
    const result = await saving;
    assert.ok(!result.isError);
    assert.equal(result.structuredContent.status, 'saved');
    assert.equal(result.structuredContent.snapshot.dirty, true);
    assert.equal(result.structuredContent.snapshot.documentId, before.documentId);
    assert.equal(w.persisted.data.workbook.sheets.sheet1.cellData[0][0].v, 'before');
    assert.equal(input.value, 'later draft');
  } finally { await f.close(); }
});

test('a confirmed live save remains successful when the current draft cannot be read afterwards', async () => {
  const f = await fixture(), { w, tools } = f;
  try {
    const before = (await tools.get('spreadsheet_snapshot')({})).structuredContent;
    const saving = tools.get('spreadsheet_save')({ operationId: 'saved-unreadable', documentId: before.documentId,
      baseContentStamp: before.contentStamp });
    await until(() => w.saving);
    w.failSnapshots = true;
    w.releaseSave();
    const result = await saving;
    assert.ok(!result.isError);
    assert.equal(result.structuredContent.status, 'saved');
    assert.equal(result.structuredContent.savedDocument.revision, 2);
    assert.equal(result.structuredContent.snapshotUnavailable, true);
    assert.equal(w.persisted.data.workbook.sheets.sheet1.cellData[0][0].v, 'before');
    assert.match(w.document.querySelector('#status').textContent, /已保存/);
    assert.equal(w.document.querySelector('.title').disabled, false);
  } finally { await f.close(); }
});
