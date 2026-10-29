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

const modes = ['univer-zh', 'univer-en', 'perspective-zh', 'perspective-en'];
const requested = process.argv[2];
assert.ok(!requested || modes.includes(requested), `Expected ${modes.join(', ')}.`);
const output = resolve('test-results/ui/app-usability');
await mkdir(output, { recursive: true });
const host = await build({ entryPoints: ['tests/host.ts'], bundle: true, write: false, platform: 'browser', format: 'esm' });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const report = { generatedAt: new Date().toISOString(), node: process.version, cases: [] };

async function eventually(read, predicate, message, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.fail(`${message}: ${JSON.stringify(value)}`);
}

function savedCell(document, row, column) {
  const book = document.data.workbook;
  return book.sheets[book.sheetOrder[0]].cellData?.[row]?.[column];
}

try {
  for (const mode of requested ? [requested] : modes) {
    const kind = mode.startsWith('univer') ? 'univer' : 'perspective';
    const locale = mode.endsWith('zh') ? 'zh-CN' : 'en-US';
    const reducedMotion = locale === 'zh-CN' ? 'no-preference' : 'reduce';
    await assertFreshAppBuild(kind);
    const result = {
      mode, kind, locale, reducedMotion, steps: [], errors: [], external: [],
      build: JSON.parse(await readFile(`plugins/extensions/${kind}/dist/integrity.json`, 'utf8')).sourceHash,
    };
    const directory = await mkdtemp(join(tmpdir(), 'app-usability-'));
    const client = new Client({ name: 'Offline human and agent workflow verification', version: '1' });
    const transport = new StdioClientTransport({
      command: process.execPath, args: [resolve(`plugins/extensions/${kind}/dist/server.cjs`)],
      env: { ...process.env, MCP_APP_DATA_DIR: directory }, stderr: 'pipe',
    });
    let server, context, page;
    try {
      await client.connect(transport);
      const call = async (name, input = {}) => {
        const response = await client.callTool({ name, arguments: input });
        assert.ok(!response.isError, `${name}: ${JSON.stringify(response)}`);
        return response;
      };
      const initial = await call('open_editor');
      const wrapper = (await client.readResource({ uri: `ui://${kind}/app.html` })).contents[0].text;
      server = createServer(async (request, response) => {
        try {
          const json = value => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); };
          if (request.url === '/wrapper') {
            response.setHeader('Content-Type', 'text/html'); response.end(wrapper);
          } else if (request.url === '/host.js') {
            response.setHeader('Content-Type', 'text/javascript'); response.end(host.outputFiles[0].text);
          } else if (request.url === '/context') {
            json({ locale });
          } else if (request.url === '/initial') {
            json(initial);
          } else if (request.url === '/tool' && request.method === 'POST') {
            const chunks = [];
            for await (const chunk of request) chunks.push(chunk);
            json(await client.callTool(JSON.parse(Buffer.concat(chunks).toString())));
          } else if (request.url === '/') {
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><style>html,body{height:100%;margin:0}iframe{width:100%;height:100%;border:0;display:block}</style><iframe sandbox="allow-scripts allow-same-origin"></iframe><script type="module" src="/host.js"></script>');
          } else response.writeHead(404).end();
        } catch (error) { response.writeHead(500).end(String(error)); }
      });
      const origin = await listenLoopback(server);
      context = await browser.newContext({ viewport: { width: 1360, height: 920 }, locale, reducedMotion });
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.hostname === '127.0.0.1' || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
        result.external.push(url.href); return route.abort();
      });
      page = await context.newPage();
      page.on('pageerror', error => result.errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') result.errors.push(message.text()); });
      await page.goto(origin);
      const frame = page.frameLocator('iframe').frameLocator('iframe');
      const prefix = kind === 'univer' ? 'spreadsheet' : 'analysis';
      const ready = () => frame.locator('.title:not(:disabled)').waitFor({ timeout: 60000 });
      const raw = (name, input = {}) => page.evaluate(params => globalThis.bridge.callTool(params), { name, arguments: input });
      const read = async (name, input = {}) => {
        let conflicts = 0;
        for (let attempt = 0; attempt < 40; attempt++) {
          const response = await raw(name, input), message = response.content?.[0]?.text ?? '';
          const retry = /^BUSY:/.test(message) || (/^CONFLICT: (?:Editor changed during (?:query|inspection)|The editor changed while reading)/.test(message) && conflicts++ < 3);
          if (response.isError && retry && attempt < 39) {
            await new Promise(resolve => setTimeout(resolve, 100)); continue;
          }
          assert.ok(!response.isError, `${name}: ${JSON.stringify(response)}`);
          return response.structuredContent;
        }
      };
      // Mutations are intentionally sent once. A lost or ambiguous write response
      // must never become a retry hidden inside a test helper.
      const write = async (name, input) => {
        const response = await raw(name, input);
        assert.ok(!response.isError, `${name}: ${JSON.stringify(response)}`);
        return response.structuredContent;
      };
      const snapshot = () => read(`${prefix}_snapshot`);
      const readSaved = async id => (await call('read_document', { id })).structuredContent;
      const modelContext = () => page.evaluate(() => {
        const text = globalThis.context?.content?.find(item => item.type === 'text')?.text;
        return text ? JSON.parse(text) : null;
      });
      const libraryContext = async () => {
        const value = await eventually(modelContext, value => value?.screen === 'library' && value.activeDocument === null,
          'The model must see the library with no active document');
        assert.equal(value.documentId, undefined);
        assert.equal(value.preview, undefined);
        return value;
      };
      const openLibrary = async () => {
        await frame.locator('[data-action="library"]').click();
        await frame.locator('#library').waitFor({ state: 'visible', timeout: 60000 });
        await ready();
        await libraryContext();
      };
      const waitEditor = async () => {
        await (kind === 'univer'
          ? frame.locator('canvas[id^="univer-sheet-main-canvas"]').first()
          : frame.locator('perspective-viewer')).waitFor({ state: 'visible', timeout: 60000 });
        await ready();
      };

      await frame.locator('#library').waitFor({ state: 'visible' });
      await ready();
      await libraryContext();
      const homeNew = frame.locator('[data-library-action="new"]');
      const homeImport = frame.locator('[data-library-action="import"]');
      await homeNew.waitFor({ state: 'visible' });
      await homeImport.waitFor({ state: 'visible' });
      assert.match(await homeNew.innerText(), locale === 'zh-CN' ? /新建/ : /new|create/i);
      assert.match(await homeImport.innerText(), locale === 'zh-CN' ? /导入/ : /import/i);
      assert.equal(await frame.locator('.title').evaluate(element => element.readOnly), true);
      for (const action of ['save', 'export', 'reload']) assert.equal(
        await frame.locator(`[data-action="${action}"]`).isDisabled(), true,
        `No-document ${action} must be visibly unavailable`,
      );
      assert.equal((await call('list_documents')).structuredContent.documents.length, 0);
      await page.screenshot({ path: join(output, `${mode}-home.png`) });
      if (reducedMotion === 'reduce') {
        await page.setViewportSize({ width: 480, height: 860 });
        await homeNew.scrollIntoViewIfNeeded();
        await homeImport.scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(output, `${mode}-home-narrow.png`) });
        await page.setViewportSize({ width: 1360, height: 920 });
      }
      result.steps.push('localized-empty-home-and-disabled-document-actions');

      await homeNew.click();
      // A blank analysis deliberately shows its import prompt rather than a
      // data viewer. The editor stage is the common ready surface here.
      await frame.locator('#editor').waitFor({ state: 'visible' });
      await ready();
      const blank = await snapshot();
      assert.equal(blank.dirty, false, 'Opening a blank document must not invent unsaved changes');
      assert.equal((await readSaved(blank.documentId)).revision, blank.revision);
      await openLibrary();
      result.steps.push('body-new-action-opens-a-clean-document');

      // Exercise the body Import action and the browser file chooser, instead
      // of bypassing the action by setting the hidden input directly.
      const choosing = page.waitForEvent('filechooser');
      await homeImport.click();
      await (await choosing).setFiles({
        name: 'Synthetic import.csv', mimeType: 'text/csv',
        buffer: Buffer.from('Item,Quantity\nImported,4\nSecond,7'),
      });
      await waitEditor();
      await eventually(() => frame.locator('.title').inputValue(), title => title === 'Synthetic import', 'Import must open the selected file');
      const imported = await snapshot();
      assert.equal(imported.dirty, false);
      if (kind === 'univer') assert.equal(savedCell(await readSaved(imported.documentId), 1, 0).v, 'Imported');
      else assert.equal((await readSaved(imported.documentId)).data.rows[0].Item, 'Imported');
      await openLibrary();
      result.steps.push('body-import-action-uses-the-real-file-chooser');

      // The agent creates a saved document through the real MCP service. The
      // tool result opens that same document through the public AppBridge.
      const created = kind === 'univer'
        ? await call('create_spreadsheet', {
          title: 'Shared synthetic worksheet', columns: ['Item', 'Quantity', 'Total'],
          rows: [['Original', 10, null], ['Second', 20, null]],
        })
        : await call('analyze_data', {
          title: 'Shared synthetic analysis', rows: [{ Item: 'Original', Quantity: 10 }, { Item: 'Second', Quantity: 20 }],
          schema: { Item: 'string', Quantity: 'integer' },
          config: { plugin: 'Datagrid', columns: ['Item', 'Quantity'], settings: false, plugin_config: { edit_mode: 'EDIT' } },
        });
      await page.evaluate(value => globalThis.bridge.sendToolResult(value), created);
      await waitEditor();
      const opened = await snapshot(), documentId = opened.documentId;
      assert.equal(documentId, created.structuredContent.id);
      assert.equal(opened.dirty, false);
      await frame.locator('#editor').evaluate(element => { globalThis.usabilityStage = element.firstElementChild; });
      const tools = await page.evaluate(() => globalThis.bridge.listTools({}));
      const saveTool = tools.tools.find(tool => tool.name === `${prefix}_save`);
      assert.ok(saveTool, 'The current App must expose agent saving');
      assert.equal(saveTool.annotations.readOnlyHint, false);
      result.steps.push('agent-created-document-opens-through-appbridge');

      let sheetId;
      if (kind === 'univer') sheetId = (await read('spreadsheet_inspect', { kind: 'sheets' })).sheets[0].id;
      const apply = async patch => {
        const current = await snapshot();
        return write(`${prefix}_apply`, {
          documentId, operationId: crypto.randomUUID(), baseContentStamp: current.contentStamp, patch,
        });
      };
      const save = async () => {
        const current = await snapshot(), operationId = crypto.randomUUID();
        const value = await write(`${prefix}_save`, {
          documentId, operationId, baseContentStamp: current.contentStamp, mode: 'document',
        });
        assert.equal(value.operationId, operationId);
        assert.equal(value.status, 'saved');
        assert.equal(value.savedDocument.id, documentId);
        assert.equal(value.snapshot?.dirty, false);
        assert.equal(value.snapshotUnavailable, undefined);
        assert.equal(await frame.locator('#editor').evaluate(element => element.firstElementChild === globalThis.usabilityStage), true,
          'Agent saving must preserve the current native editor instance');
        const persisted = await readSaved(documentId);
        assert.equal(value.savedDocument.revision, persisted.revision);
        return { value, persisted, operationId, baseContentStamp: current.contentStamp };
      };
      const source = async () => kind === 'univer'
        ? read('spreadsheet_query', { sheetId, startRow: 1, startColumn: 0, rowCount: 2, columnCount: 3 })
        : read('analysis_inspect', { kind: 'source', offset: 0, limit: 2 });
      await apply(kind === 'univer'
        ? { operation: { type: 'cells', sheetId, cells: [{ row: 2, column: 1, value: 30 }, { row: 1, column: 2, formula: '=B2*2' }] } }
        : { cells: [{ row: 1, column: 'Quantity', value: 30 }] });
      const firstSave = await save();
      assert.equal(firstSave.persisted.revision, created.structuredContent.revision + 1);
      assert.equal(kind === 'univer' ? savedCell(firstSave.persisted, 2, 1).v : firstSave.persisted.data.rows[1].Quantity, 30);
      const replay = await raw(`${prefix}_save`, {
        documentId, operationId: firstSave.operationId, baseContentStamp: firstSave.baseContentStamp, mode: 'document',
      });
      assert.equal(replay.isError, true, 'A save operation ID must not replay a write');
      assert.equal((await readSaved(documentId)).revision, firstSave.persisted.revision);
      result.steps.push('agent-apply-save-and-replayed-save-refusal');

      const beforeHandEdit = await snapshot();
      if (kind === 'univer') {
        const box = frame.locator('[data-u-comp="defined-name"] input');
        await box.fill('A2'); await box.press('Enter');
        await page.keyboard.type('Manual input remains');
      } else {
        const cell = frame.locator('perspective-viewer-datagrid regular-table td').filter({ hasText: /^Original$/ });
        await cell.click(); await page.keyboard.press('Control+a');
        await page.keyboard.insertText('Manual input remains');
      }
      // Do not press Enter: preparing a live read must capture pending human
      // input, or safely report a bounded read conflict before a fresh read.
      await snapshot();
      const human = await source();
      assert.equal(kind === 'univer' ? human.cells[0][0].value : human.rows[0].Item, 'Manual input remains');
      const stale = await raw(`${prefix}_save`, {
        documentId, operationId: crypto.randomUUID(), baseContentStamp: beforeHandEdit.contentStamp, mode: 'document',
      });
      assert.equal(stale.isError, true, 'An old stamp must not save over a later human edit');
      assert.equal((await readSaved(documentId)).revision, firstSave.persisted.revision);

      if (kind === 'univer') {
        const box = frame.locator('[data-u-comp="defined-name"] input');
        await box.fill('B2'); await box.press('Enter');
        await page.keyboard.type('42'); await page.keyboard.press('Enter');
        const current = await source();
        assert.equal(current.cells[0][1].value, 42);
        assert.equal(current.cells[0][2].value, 84, 'Human input must recalculate the agent formula');
      } else {
        let displayedQuantity = 10;
        const editQuantity = async (text, finish, expected, panelId) => {
          const viewer = frame.locator('perspective-viewer');
          let cells = viewer.locator('perspective-viewer-datagrid regular-table td');
          if (panelId) {
            assert.match(panelId, /^[\w-]+$/);
            const active = await viewer.evaluate(async element => {
              const plugin = await element.getPlugin();
              return { panel: element.getActivePanel(), tag: plugin.tagName, slot: plugin.getAttribute('slot') };
            });
            assert.deepEqual(active, { panel: panelId, tag: 'PERSPECTIVE-VIEWER-DATAGRID', slot: panelId },
              'Keyboard input must target the current panel rather than another Datagrid');
            const grid = viewer.locator(`perspective-viewer-datagrid[slot="${panelId}"] regular-table`);
            await grid.waitFor({ state: 'visible' });
            cells = grid.locator('td');
          }
          const index = await cells.evaluateAll((elements, value) => elements.findIndex(element => element.textContent.replace(/,/g, '').trim() === String(value)), displayedQuantity);
          assert.ok(index >= 0, `The current quantity ${displayedQuantity} must be visible`);
          const cell = cells.nth(index);
          await cell.click();
          assert.equal(await cell.evaluate(element => element.isContentEditable), true);
          await page.keyboard.press('Control+a'); await page.keyboard.insertText(text);
          if (finish === 'enter') await page.keyboard.press('Enter');
          else if (finish === 'tab') await page.keyboard.press('Tab');
          else if (finish === 'cell') await cells.filter({ hasText: /^Manual input remains$/ }).click();
          else await frame.locator('.title').click();
          await viewer.evaluate(element => element.flush());
          const current = await eventually(source, value => value.rows[0].Quantity === expected, `The real source must settle at ${expected}`);
          displayedQuantity = expected;
          return current;
        };
        let current = await editQuantity('2147483648', 'enter', 10);
        assert.equal(current.rows[0].Quantity, 10, 'An overflowing integer must not wrap after Enter');
        assert.ok((await frame.locator('.analysis-feedback').innerText()).trim(), 'Invalid manual input needs visible feedback');
        current = await editQuantity('2147483647', 'enter', 2147483647);
        assert.equal(current.rows[0].Quantity, 2147483647, 'A valid boundary integer must remain editable');
        current = await editQuantity('1.5', 'tab', 2147483647);
        assert.equal(current.rows[0].Quantity, 2147483647, 'A fractional integer must not truncate on blur');
        current = await editQuantity('12abc', 'cell', 2147483647);
        assert.equal(current.rows[0].Quantity, 2147483647, 'Moving to another cell must not parse only a numeric prefix');
        current = await editQuantity('42', 'toolbar', 42);
        assert.equal(current.rows[0].Quantity, 42, 'A valid integer must commit on blur');
        result.steps.push('native-integer-valid-and-invalid-enter-and-blur');

        if (mode === 'perspective-zh') {
          const main = (await snapshot()).workspace.activePanel;
          const editable = { plugin: 'Datagrid', columns: ['Item', 'Quantity'], group_by: [], split_by: [], settings: false, plugin_config: { edit_mode: 'EDIT' } };
          await apply({ panelId: main, config: { plugin: 'Y Bar', columns: ['Quantity'], group_by: ['Item'], settings: false } });
          assert.equal((await snapshot()).workspace.panels[main].plugin, 'Y Bar');
          await apply({ panelId: main, config: editable });
          await editQuantity('2147483648', 'enter', 42, main);
          await editQuantity('43', 'enter', 43, main);

          const panelAction = async action => {
            await frame.locator(`[data-analysis-action="${action}"]`).click();
            await ready();
            return (await snapshot()).workspace;
          };
          const copied = await panelAction('duplicate'), copyId = copied.activePanel;
          assert.notEqual(copyId, main);
          assert.equal(Object.keys(copied.panels).length, 2);
          assert.equal(copied.panels[copyId].plugin_config.edit_mode, 'EDIT');
          await editQuantity('2147483648', 'tab', 43, copyId);
          await editQuantity('44', 'cell', 44, copyId);
          const afterCopy = await panelAction('close');
          assert.equal(afterCopy.activePanel, main);

          await frame.locator('[data-analysis-chart]').selectOption('Datagrid');
          const added = await panelAction('add'), addedId = added.activePanel;
          assert.notEqual(addedId, main);
          assert.notEqual(addedId, copyId);
          assert.equal(Object.keys(added.panels).length, 2);
          await apply({ panelId: addedId, config: editable });
          await editQuantity('12abc', 'cell', 44, addedId);
          await editQuantity('45', 'toolbar', 45, addedId);
          const afterAdd = await panelAction('close');
          assert.deepEqual(Object.keys(afterAdd.panels), [main]);
          assert.equal(afterAdd.activePanel, main);
          await editQuantity('42', 'enter', 42, main);
          result.steps.push('native-guard-rebinds-after-chart-switch-copy-and-add');
        }
      }
      await apply(kind === 'univer'
        ? { operation: { type: 'cells', sheetId, cells: [{ row: 2, column: 0, value: 'Agent follow-up' }, { row: 2, column: 2, formula: '=B3*2' }] } }
        : { cells: [{ row: 1, column: 'Item', value: 'Agent follow-up' }], config: { plugin: 'Y Bar', columns: ['Quantity'], group_by: ['Item'], settings: false } });
      const finalSave = await save();
      assert.equal(finalSave.persisted.revision, firstSave.persisted.revision + 1);
      if (kind === 'univer') {
        assert.equal(savedCell(finalSave.persisted, 1, 0).v, 'Manual input remains');
        assert.equal(savedCell(finalSave.persisted, 1, 1).v, 42);
        assert.equal(savedCell(finalSave.persisted, 1, 2).v, 84);
        assert.equal(savedCell(finalSave.persisted, 2, 0).v, 'Agent follow-up');
        assert.equal(savedCell(finalSave.persisted, 2, 2).v, 60);
      } else {
        assert.deepEqual(finalSave.persisted.data.rows, [{ Item: 'Manual input remains', Quantity: 42 }, { Item: 'Agent follow-up', Quantity: 30 }]);
        assert.equal(finalSave.persisted.data.config.plugin, 'Y Bar');
      }
      await page.screenshot({ path: join(output, `${mode}-collaboration.png`) });
      await openLibrary();
      const search = frame.locator('[data-document-search]');
      await search.fill(created.structuredContent.title);
      assert.equal(await frame.locator('#library .document').count(), 1, 'Search must find the agent-created document among local documents');
      assert.equal(await frame.locator('#library .document').getAttribute('data-document-id'), documentId);
      await frame.locator('#library .document').filter({ hasText: created.structuredContent.title }).click();
      await waitEditor();
      const reopened = await snapshot(), reopenedData = await source();
      assert.equal(reopened.documentId, documentId);
      assert.equal(reopened.revision, finalSave.persisted.revision);
      assert.equal(reopened.dirty, false);
      assert.equal(kind === 'univer' ? reopenedData.cells[0][0].value : reopenedData.rows[0].Item, 'Manual input remains');
      assert.equal(kind === 'univer' ? reopenedData.cells[0][1].value : reopenedData.rows[0].Quantity, 42);
      assert.equal(kind === 'univer' ? reopenedData.cells[1][0].value : reopenedData.rows[1].Item, 'Agent follow-up');
      result.steps.push('pending-human-edit-agent-follow-up-save-and-reopen');

      // A slow, public host callback exposes ordering races without patching the
      // App runtime or using a host-private transport.
      await page.waitForTimeout(400);
      await page.evaluate(() => {
        globalThis.contextProbe = { active: 0, maxActive: 0, events: [] };
        globalThis.bridge.onupdatemodelcontext = async params => {
          const probe = globalThis.contextProbe;
          probe.active++; probe.maxActive = Math.max(probe.maxActive, probe.active);
          const value = JSON.parse(params.content.find(item => item.type === 'text').text);
          probe.events.push({ phase: 'start', value });
          await new Promise(resolve => setTimeout(resolve, 350));
          globalThis.context = params;
          probe.events.push({ phase: 'end', value });
          probe.active--;
          return {};
        };
      });
      await frame.locator('.title').fill('Temporary context title');
      await eventually(() => page.evaluate(() => globalThis.contextProbe.active), value => value === 1, 'A background context update must start');
      const prepared = await read('prepare_context');
      assert.equal(prepared.documentId, documentId);
      assert.ok(prepared.contentStamp);
      assert.equal(await page.evaluate(() => globalThis.contextProbe.maxActive), 1, 'Background and prepare_context sends must share one channel');
      await frame.locator('.title').fill('Discard this context title');
      await eventually(() => page.evaluate(() => globalThis.contextProbe.active), value => value === 1, 'A stale document context must be in flight before leaving');
      await frame.locator('[data-action="library"]').click();
      const dialog = frame.getByRole('dialog');
      await dialog.getByRole('button', { name: locale === 'zh-CN' ? '放弃修改' : 'Discard', exact: true }).click();
      await frame.locator('#library').waitFor({ state: 'visible' });
      await ready(); await libraryContext();
      await page.waitForTimeout(800);
      const finalContext = await libraryContext();
      result.contextProbe = await page.evaluate(() => ({
        maxActive: globalThis.contextProbe.maxActive,
        completed: globalThis.contextProbe.events.filter(event => event.phase === 'end').map(event => ({
          screen: event.value.screen, activeDocument: event.value.activeDocument,
          documentId: event.value.documentId, title: event.value.title, contentStamp: event.value.contentStamp,
        })),
      }));
      assert.equal(result.contextProbe.maxActive, 1);
      const libraryIndex = result.contextProbe.completed.findIndex(value => value.screen === 'library');
      assert.ok(libraryIndex >= 0, 'Leaving must publish a completed library context');
      assert.ok(result.contextProbe.completed.slice(libraryIndex).every(value => value.documentId === undefined), 'A delayed document context must not replace the library');
      assert.equal(finalContext.activeDocument, null);
      assert.equal((await readSaved(documentId)).title, created.structuredContent.title, 'Discarded titles must not leak into persistence');
      result.steps.push('serialized-background-and-prepared-context-with-library-handoff');

      assert.deepEqual(result.errors, []);
      assert.deepEqual(result.external, []);
      result.passed = true;
    } catch (error) {
      result.failure = error.stack ?? String(error);
      await page?.screenshot({ path: join(output, `${mode}-failure.png`) }).catch(() => undefined);
      throw error;
    } finally {
      report.cases.push(result);
      await writeFile(join(output, `${mode}.json`), JSON.stringify(result, null, 2));
      await context?.close();
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
      await new Promise(resolve => server ? server.close(resolve) : resolve());
      assert.equal(dirname(directory), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('app-usability-'));
      await rm(directory, { recursive: true, force: true });
    }
  }
} finally {
  await browser.close();
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report));
