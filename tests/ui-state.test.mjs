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
    async load(doc) { model = input.value = doc.data.workbook.sheets.sheet1.cellData[0][0].v; },
    async commitEdit() {
      globalThis.commitLocks.push(container.inert === true);
      if (model !== input.value) { model = input.value; changed(); }
    },
    async snapshot() {
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
      if (globalThis.queueMode && !globalThis.scheduled) {
        globalThis.scheduled = true;
        const next = n => queueMicrotask(() => n ? next(n - 1) : globalThis.startConcurrent());
        next(globalThis.queueDelay);
      }
      return {};
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
async function fixture({ draftOnly = false, queueMode = false, queueDelay = 3 } = {}) {
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
      return {};
    },
    getHostContext() {
      return { locale: 'zh-CN' };
    },
    async connect() {},
    async callServerTool({ name, arguments: input }) {
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
