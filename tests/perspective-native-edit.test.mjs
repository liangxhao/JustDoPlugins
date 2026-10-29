import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const bundle = await build({
  stdin: {
    contents: `import {createNativeEditGuard, normalizeNativeEdit} from './plugins/extensions/perspective/native-edit';
import {serializeAnalysisDocument, parseAnalysisInput} from './plugins/extensions/perspective/data-input';
import {createEditPointerdownListener} from './node_modules/@perspective-dev/viewer-datagrid/src/ts/event_handlers/edit_focus';
import {createFocusinListener, createFocusoutListener} from './node_modules/@perspective-dev/viewer-datagrid/src/ts/event_handlers/focus';
import {focusSelectedCell} from './node_modules/@perspective-dev/viewer-datagrid/src/ts/style_handlers/focus';
globalThis.editApi = {createNativeEditGuard, normalizeNativeEdit, serializeAnalysisDocument, parseAnalysisInput,
  upstream: {createEditPointerdownListener, createFocusinListener, createFocusoutListener, focusSelectedCell}};`,
    resolveDir: process.cwd(), loader: 'ts',
  },
  bundle: true, platform: 'browser', format: 'iife', write: false,
});

function fixture() {
  const dom = new JSDOM('<!doctype html>', { runScripts: 'outside-only' });
  Object.assign(dom.window, { TextEncoder, TextDecoder });
  dom.window.eval(bundle.outputFiles[0].text);
  return { dom, window: dom.window, api: dom.window.editApi };
}

test('native typed edits use complete input and the canonical source value contract', () => {
  const { dom, api } = fixture();
  try {
    const value = (text, type) => api.normalizeNativeEdit(text, type, 'Value');
    assert.equal(value('2,147,483,647', 'integer'), 2147483647);
    assert.equal(value('-2147483648', 'integer'), -2147483648);
    assert.equal(value(' 1e3 ', 'integer'), 1000);
    assert.equal(value('-1,234.5e-2', 'float'), -12.345);
    assert.equal(value('.5', 'float'), 0.5);
    assert.equal(value('001', 'string'), '001');
    assert.equal(value('2024-02-29', 'date'), Date.parse('2024-02-29T00:00:00Z'));
    assert.equal(value('2024-03-01T08:30:00.123+08:00', 'datetime'), Date.parse('2024-03-01T00:30:00.123Z'));
    for (const text of ['2147483648', '-2147483649', '1.5', '10suffix', '0x10', '1,2', '1,,000', '', 'Infinity'])
      assert.throws(() => value(text, 'integer'), undefined, text);
    for (const text of ['1e999', 'NaN', '1.5suffix']) assert.throws(() => value(text, 'float'));
    for (const text of ['2026-02-30', '02/30/2026', '2026-1-01']) assert.throws(() => value(text, 'date'));
    assert.throws(() => value('2026-10-29T12:30:00', 'datetime'));
    assert.throws(() => value('a'.repeat(32769), 'string'));
  } finally { dom.window.close(); }
});

test('capture guard restores invalid edits before native writing and preserves normal focus cleanup', () => {
  const { dom, window, api } = fixture();
  try {
    const table = window.document.createElement('regular-table');
    table.innerHTML = '<table><tbody><tr><td data-column="count">10</td><td data-column="label">Original</td></tr></tbody></table>';
    window.document.body.append(table);
    const [number, label] = table.querySelectorAll('td');
    table.getMeta = cell => ({ type: 'body', column_header: [cell.dataset.column] });
    const nativeOriginals = new WeakMap(), writes = [], rejected = [], accepted = [];
    table.addEventListener('focusin', event => nativeOriginals.set(event.target, event.target.textContent));
    table.addEventListener('focusout', event => {
      const cell = event.target;
      if (cell.textContent !== nativeOriginals.get(cell)) writes.push(cell.textContent);
      cell.removeAttribute('contenteditable');
    });
    const controller = new window.AbortController();
    const attach = api.createNativeEditGuard({
      schema: () => ({ count: 'integer', label: 'string' }),
      invalid: (column, type) => rejected.push({ column, type }), signal: controller.signal,
      valid: () => accepted.push(true),
    });
    attach(table); attach(table);
    const edit = (cell, text) => {
      cell.setAttribute('contenteditable', 'true');
      cell.dispatchEvent(new window.FocusEvent('focusin', { bubbles: true, composed: true }));
      cell.textContent = text;
      cell.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true, composed: true }));
    };
    edit(number, '2147483648');
    assert.equal(number.textContent, '10');
    assert.equal(number.hasAttribute('contenteditable'), false, 'Native focus cleanup still runs');
    assert.equal(writes.length, 0, 'The invalid integer never reaches the native writer');
    assert.equal(rejected.length, 1, 'Repeated attachment must not duplicate handling');
    edit(number, '2147483647'); edit(label, '001');
    assert.deepEqual(writes, ['2147483647', '001']);
    assert.equal(accepted.length, 2);
    number.textContent = '2,147,483,647'; edit(number, '2,147,483,647');
    assert.equal(writes.length, 2, 'Unchanged localized text is never reinterpreted');
    assert.equal(accepted.length, 2, 'Unchanged text does not announce a successful new edit');
    controller.abort(); edit(number, '2147483648');
    assert.equal(writes.length, 3, 'Disposal removes the capture listener');
    assert.equal(rejected.length, 1);
    assert.equal(accepted.length, 2);
  } finally { dom.window.close(); }
});

for (const transition of ['pointerdown', 'keyboard']) {
  test(`native ${transition} navigation cannot bypass validation after moving the editable marker`, () => {
    const { dom, window, api } = fixture();
    try {
      const table = window.document.createElement('regular-table');
      table.innerHTML = '<table><thead><tr><th>Count</th><th>Label</th></tr></thead><tbody><tr><td tabindex="0" data-column="count">10</td><td tabindex="0" data-column="label">Original</td></tr></tbody></table>';
      window.document.body.append(table);
      const [number, label] = table.querySelectorAll('td');
      table.getMeta = cell => ({ type: 'body', column_header: [cell.dataset.column], x: cell === number ? 0 : 1, y: 0, y0: 0 });
      const writes = [], rejected = [], editableAtBlur = [];
      // Use the locked upstream handlers so moving their editable marker and
      // writing on focusout have their real ordering, rather than a mock copy.
      const model = {
        _config: { group_by: [], split_by: [] }, _edit_mode: 'EDIT',
        _is_editable: [true, true], _column_types: ['integer', 'string'],
        _schema: { count: 'integer', label: 'string' }, _column_paths: ['count', 'label'],
        _ids: [[0]], _table: { update: rows => writes.push(rows) },
      };
      const selected = new WeakMap(), upstream = api.upstream;
      table.addEventListener('pointerdown', upstream.createEditPointerdownListener(model, table, {}));
      table.addEventListener('focusin', upstream.createFocusinListener(model, table, {}, selected));
      table.addEventListener('focusout', upstream.createFocusoutListener(model, table, {}, selected));
      table.addEventListener('focusout', event => {
        if (event.target === number) editableAtBlur.push(number.hasAttribute('contenteditable'));
      }, { capture: true });
      api.createNativeEditGuard({
        schema: () => ({ count: 'integer', label: 'string' }),
        invalid: (column, type) => rejected.push({ column, type }), signal: new window.AbortController().signal,
      })(table);
      number.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
      number.focus();
      number.textContent = transition === 'pointerdown' ? '1.5' : '2147483648';
      if (transition === 'pointerdown') {
        label.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
        assert.equal(number.hasAttribute('contenteditable'), false);
        label.focus();
      } else {
        selected.get(table).x = 1;
        assert.equal(upstream.focusSelectedCell(table, selected, model), true);
      }
      assert.equal(editableAtBlur[0], false, 'The upstream removes the old marker before focusout');
      assert.equal(writes.length, 0, 'The invalid value never reaches Table.update');
      assert.equal(number.textContent, '10');
      assert.equal(rejected.length, 1);
      assert.equal(window.document.activeElement, label, 'Native navigation and cleanup complete');
    } finally { dom.window.close(); }
  });
}

test('complete analysis JSON near the document limit can be exported and imported without whitespace inflation', async () => {
  const { dom, api } = fixture();
  try {
    const columns = Array.from({ length: 12 }, (_, i) => `c${String(i).padStart(2, '0')}`);
    const data = {
      rows: Array.from({ length: 5000 }, () => Object.fromEntries(columns.map(name => [name, 'abcdefghijklmnopqrst']))),
      workspace: {
        panels: { main: { plugin: 'Datagrid', columns, title: 'Main' } },
        activePanel: 'main', settings: false,
        layout: { type: 'tab-layout', tabs: ['main'] },
        palette: { '--psp-user--color-brand': '#336699' },
      },
    };
    const before = structuredClone(data), text = api.serializeAnalysisDocument(data);
    assert.ok(Buffer.byteLength(text) <= 2 * 1024 * 1024);
    assert.ok(Buffer.byteLength(JSON.stringify(JSON.parse(text), null, 2)) > 2 * 1024 * 1024,
      'The previous pretty export would exceed the file import budget');
    const restored = await api.parseAnalysisInput({ format: 'json', text });
    assert.deepEqual(JSON.parse(api.serializeAnalysisDocument(restored)), JSON.parse(text));
    assert.deepEqual(data, before, 'Serialization never modifies the editable document');
  } finally { dom.window.close(); }
});
