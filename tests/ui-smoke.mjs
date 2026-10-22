import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { build } from 'esbuild';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import ExcelJS from 'exceljs';
import { spreadsheetFixture } from './xlsx-fixture.mjs';

const host = await build({
  entryPoints: ['tests/host.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
});
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const reports = resolve('test-results/ui');
await mkdir(join(reports, 'screenshots'), { recursive: true });
try {
  const modes = ['univer', 'perspective', 'univer-file', 'univer-write'];
  if (process.argv[2] && !modes.includes(process.argv[2])) throw new Error('Unknown UI test mode');
  for (const mode of process.argv[2] ? [process.argv[2]] : modes) {
    const name = mode.startsWith('univer-') ? 'univer' : mode;
    const fileMode = mode.startsWith('univer-');
    const writable = mode === 'univer-write';
    const fixture = fileMode ? await spreadsheetFixture(false, true) : undefined;
    let sourceBytes = fixture;
    let writeUnknown = false;
    const sourceWrites = [];
    const etag = () => createHash('sha256').update(sourceBytes).digest('hex');
    const fileToken = 'b'.repeat(64);
    const fileUri = `app-file://${fileToken}`;
    const dir = await mkdtemp(join(tmpdir(), 'mcp-app-ui-'));
    const client = new Client({ name: 'offline-ui-test', version: '1.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [resolve('plugins', name, 'dist/server.cjs')],
        env: { ...process.env, MCP_APP_DATA_DIR: dir },
        stderr: 'pipe',
      }),
    );
    if (fileMode) {
      assert.ok(fixture.length > 256 * 1024);
      const staged = await client.callTool({
        name: 'stage_workspace_file',
        arguments: {
          token: fileToken,
          name: '预算.xlsx',
          blob: fixture.toString('base64'),
        },
      });
      assert.ok(!staged.isError, JSON.stringify(staged));
    }
    const initial = await client.callTool(
      fileMode
        ? { name: 'open_editor', arguments: {} }
        : name === 'univer'
          ? {
              name: 'create_spreadsheet',
              arguments: {
                title: '项目预算',
                columns: ['部门', '项目', '预算', '实际'],
                rows: [
                  ['研发', '平台升级', 80000, 75000],
                  ['市场', '客户活动', 45000, 42000],
                  ['研发', '测试设备', 20000, 18500],
                  ['运营', '培训', 12000, 9800],
                ],
              },
            }
          : {
              name: 'analyze_data',
              arguments: {
                title: '部门预算分析',
                rows: [
                  { 部门: '研发', 项目: '平台升级', 预算: 80000, 实际: 75000 },
                  { 部门: '市场', 项目: '客户活动', 预算: 45000, 实际: 42000 },
                  { 部门: '研发', 项目: '测试设备', 预算: 20000, 实际: 18500 },
                  { 部门: '运营', 项目: '培训', 预算: 12000, 实际: 9800 },
                ],
              },
            },
    );
    const resource = await client.readResource({
      uri: `ui://${name}/app.html`,
    });
    const wrapper = resource.contents[0].text;
    const errors = [],
      requests = [];
    const server = createServer(async (req, res) => {
      if (req.url === '/wrapper') {
        res.setHeader('Content-Type', 'text/html');
        res.end(wrapper);
      } else if (req.url === '/host.js') {
        res.setHeader('Content-Type', 'application/javascript');
        res.end(host.outputFiles[0].text);
      } else if (req.url === '/context') {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify(
            fileMode ? { 'openai/deepLink': { url: `/workspace-file/${fileToken}` } } : {},
          ),
        );
      } else if (req.url === '/initial') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(initial));
      } else if (req.url === '/resource') {
        const buffers = [];
        for await (const data of req) buffers.push(data);
        const params = JSON.parse(Buffer.concat(buffers).toString());
        if (!fileMode || params.uri !== fileUri) {
          res.writeHead(404).end();
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify(
            writable
              ? {
                  contents: [
                    {
                      uri: fileUri,
                      blob: sourceBytes.toString('base64'),
                      mimeType: 'application/octet-stream',
                      _meta: {
                        'openai/resource': { writable: true, etag: etag() },
                      },
                    },
                  ],
                }
              : await client.readResource({ uri: params.uri }),
          ),
        );
      } else if (req.url === '/write') {
        const buffers = [];
        for await (const data of req) buffers.push(data);
        const params = JSON.parse(Buffer.concat(buffers).toString());
        sourceWrites.push(params);
        if (!writable || params.uri !== fileUri || writeUnknown) {
          res.writeHead(503).end();
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        if (params.ifMatch !== etag()) res.end(JSON.stringify({ outcome: 'conflict' }));
        else {
          sourceBytes = Buffer.from(params.blob, 'base64');
          res.end(JSON.stringify({ outcome: 'saved', etag: etag() }));
        }
      } else if (req.url === '/tool') {
        const buffers = [];
        for await (const data of req) buffers.push(data);
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify(await client.callTool(JSON.parse(Buffer.concat(buffers).toString()))),
        );
      } else {
        res.setHeader('Content-Type', 'text/html');
        res.end(
          '<!doctype html><iframe style="width:100%;height:720px;border:0" sandbox="allow-scripts allow-same-origin"></iframe><script type="module" src="/host.js"></script>',
        );
      }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const context = await browser.newContext({
      viewport: { width: 1360, height: 790 },
    });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      requests.push(url.href);
      if (
        ['127.0.0.1', 'localhost'].includes(url.hostname) ||
        ['data:', 'blob:'].includes(url.protocol)
      )
        return route.continue();
      errors.push(`External request: ${url.origin}`);
      return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      const wrapperFrame = page.frameLocator('iframe');
      const editor = wrapperFrame.frameLocator('iframe');
      if (writable) {
        await editor.locator('#status').filter({ hasText: '已保存' }).waitFor({ timeout: 90000 });
        await editor.locator('.title:not(:disabled)').waitFor();
        const nameBox = editor.locator('[data-u-comp="defined-name"] input');
        await nameBox.fill('C3');
        await nameBox.press('Enter');
        await page.keyboard.type('90000', { delay: 40 });
        await editor
          .getByRole('button', { name: '保存', exact: true })
          .evaluate(button => button.click());
        await editor.locator('#status').filter({ hasText: '已保存' }).waitFor();
        await editor.locator('.title:not(:disabled)').waitFor();
        assert.equal(sourceWrites.length, 1);
        const saved = new ExcelJS.Workbook();
        await saved.xlsx.load(sourceBytes);
        assert.equal(
          saved.getWorksheet('部门预算').getCell('C3').value,
          90000,
          'An active cell edit must reach the source XLSX',
        );
        assert.equal(
          saved.getWorksheet('部门预算').getCell('C5').result,
          135000,
          'Source saves include applied formula results',
        );
        assert.ok(
          saved.getWorksheet('说明').getCell('A2').value.richText,
          'Unchanged rich text remains in the original package',
        );
        sourceBytes = Buffer.concat([sourceBytes, Buffer.from('external edit')]);
        await page.setViewportSize({ width: 420, height: 790 });
        await editor.getByRole('button', { name: '保存', exact: true }).click();
        await editor
          .locator('#status.error')
          .filter({ hasText: '文件已被其他程序修改' })
          .waitFor({ state: 'visible' });
        assert.equal(sourceWrites.length, 2);
        const beforeUnknown = sourceBytes;
        writeUnknown = true;
        await editor.getByRole('button', { name: '保存', exact: true }).click();
        await editor
          .locator('#status.error')
          .filter({ hasText: 'unknown' })
          .waitFor({ state: 'visible' });
        await editor.getByRole('button', { name: '保存', exact: true }).click();
        await editor
          .locator('#status.error')
          .filter({ hasText: '保存结果未确认' })
          .waitFor({ state: 'visible' });
        assert.equal(
          sourceWrites.length,
          3,
          'An uncertain source save must not be automatically retried',
        );
        assert.deepEqual(sourceBytes, beforeUnknown);
        await page.screenshot({
          path: join(reports, 'screenshots', 'univer-source-conflict.png'),
        });
        assert.deepEqual(
          errors.filter(error => !error.includes('503')),
          [],
        );
        await writeFile(
          join(reports, 'univer-source-write-proof.json'),
          JSON.stringify(
            {
              activeCellCommitted: true,
              formulaResult: saved.getWorksheet('部门预算').getCell('C5').result,
              unchangedRichText: true,
              sourceConflictVisibleAt420px: true,
              uncertainWriteNotRetried: true,
              writeRequests: sourceWrites.length,
              host: 'Isolated AppBridge source resource fixture; filesystem admission is covered separately',
              requests,
              errors,
            },
            null,
            2,
          ),
        );
        console.log(
          'univer: writable XLSX commits the active cell, preserves source parts, shows narrow conflicts and blocks uncertain retries; no public requests',
        );
        continue;
      }
      if (fileMode) {
        await editor.locator('#status').filter({ hasText: '只读预览' }).waitFor({ timeout: 90000 });
        await editor.locator('.title:not(:disabled)').waitFor();
        assert.equal(await editor.locator('.title').getAttribute('readonly'), '');
        const modelContext = await page.evaluate(() => JSON.stringify(globalThis.context));
        assert.ok(
          !modelContext.includes(fileToken),
          'Snapshot bearer tokens must never reach the model',
        );
        const documents = await client.callTool({
          name: 'list_documents',
          arguments: {},
        });
        assert.equal(documents.structuredContent.documents.length, 0);
        const nameBox = editor.locator('[data-u-comp="defined-name"] input');
        await nameBox.fill('C3');
        await nameBox.press('Enter');
        await page.keyboard.type('99999', { delay: 40 });
        await page.keyboard.press('Enter');
        await editor.getByRole('button', { name: '导出 XLSX', exact: true }).click();
        await page.waitForFunction(() => globalThis.download);
        const download = await page.evaluate(() => globalThis.download);
        const exported = new ExcelJS.Workbook();
        await exported.xlsx.load(Buffer.from(download.contents[0].resource.blob, 'base64'));
        assert.equal(exported.worksheets.length, 2);
        assert.equal(
          exported.getWorksheet('部门预算').getCell('C3').value,
          80000,
          'Read-only previews must reject typing',
        );
        assert.equal(exported.getWorksheet('部门预算').getCell('C5').formula, 'SUM(C3:C4)');
        assert.equal(exported.getWorksheet('部门预算').getCell('C5').result, 125000);
        await editor.getByRole('button', { name: '重新读取', exact: true }).click();
        await editor.locator('#status').filter({ hasText: '只读预览' }).waitFor();
        await editor.locator('.title:not(:disabled)').waitFor();
        await page.screenshot({
          path: join(reports, 'screenshots', 'univer-xlsx-preview.png'),
        });
        assert.equal(await editor.getByRole('button', { name: /编辑副本|Edit a copy/ }).count(), 0);
        assert.equal(await editor.getByRole('button', { name: '保存', exact: true }).count(), 0);
        await editor.locator('.title:not(:disabled)').waitFor();
        await editor.locator('#file').setInputFiles({
          name: '本机导入.xlsx',
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          buffer: fixture,
        });
        await editor.locator('.title').filter().waitFor();
        await page.waitForFunction(() =>
          globalThis.context?.content?.some(item => item.text.includes('本机导入')),
        );
        await editor.locator('.title:not(:disabled)').waitFor();
        assert.equal(await editor.locator('.title').inputValue(), '本机导入');
        await mkdir(join(reports, 'fixtures'), { recursive: true });
        await writeFile(join(reports, 'fixtures', '预算.xlsx'), fixture);
        await page.setViewportSize({ width: 560, height: 790 });
        await page.screenshot({
          path: join(reports, 'screenshots', 'univer-xlsx-sidebar.png'),
        });
        assert.deepEqual(errors, []);
        await writeFile(
          join(reports, 'univer-xlsx-proof.json'),
          JSON.stringify(
            {
              readOnly: true,
              sourceBytes: fixture.length,
              privateSnapshot: true,
              sourceEditingRequiresNativeHost: true,
              xlsxImported: true,
              xlsxExported: true,
              requests,
              errors,
            },
            null,
            2,
          ),
        );
        console.log(
          'univer: real XLSX read-only fallback, reload, import/export passed; no public requests',
        );
        continue;
      }
      await editor.locator('#status').filter({ hasText: '已保存' }).waitFor({ timeout: 90000 });
      await editor.locator('.title:not(:disabled)').waitFor();
      if (name === 'univer') {
        const canvas = editor.locator('canvas[id^="univer-sheet-main-canvas"]');
        await canvas.click({ position: { x: 260, y: 55 } });
        await canvas.evaluate(
          () =>
            new Promise(resolve =>
              globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve)),
            ),
        );
        await page.keyboard.type('90000', { delay: 40 });
        await canvas.evaluate(
          () =>
            new Promise(resolve =>
              globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve)),
            ),
        );
        // Click without blurring/Enter: an active cell editor is not a saved snapshot.
        await editor
          .getByRole('button', { name: '保存', exact: true })
          .evaluate(button => button.click());
        await editor.locator('#status').filter({ hasText: '已保存' }).waitFor();
        await editor.locator('.title:not(:disabled)').waitFor();
        const committed = await client.callTool({
          name: 'read_document',
          arguments: { id: initial.structuredContent.id },
        });
        assert.equal(
          committed.structuredContent.data.workbook.sheets.sheet1.cellData[1][2].v,
          90000,
        );
      } else {
        const viewer = editor.locator('perspective-viewer');
        await viewer.evaluate(async element =>
          element.restore({
            group_by: ['部门'],
            columns: ['预算', '实际'],
            plugin: 'Y Bar',
            settings: false,
          }),
        );
      }
      await editor.locator('.title').fill(`${name} edited`);
      await editor.getByRole('button', { name: '保存', exact: true }).click();
      await editor.locator('#status').filter({ hasText: '已保存' }).waitFor();
      const persisted = await client.callTool({
        name: 'read_document',
        arguments: { id: initial.structuredContent.id },
      });
      assert.equal(persisted.structuredContent.title, `${name} edited`);
      if (name === 'univer')
        assert.equal(
          persisted.structuredContent.data.workbook.sheets.sheet1.cellData[1][2].v,
          90000,
        );
      else assert.deepEqual(persisted.structuredContent.data.config.group_by, ['部门']);
      await page.evaluate(() => globalThis.bridge.setHostContext({ theme: 'dark' }));
      await editor.locator('html[data-theme="dark"]').waitFor();
      if (name === 'perspective')
        await editor.locator('perspective-viewer').evaluate(element => element.flush());
      assert.equal(
        await editor.locator('#status').textContent(),
        '已保存',
        'A host theme change is not a document edit',
      );
      await page.evaluate(() => globalThis.bridge.setHostContext({ theme: 'light' }));
      await editor.locator('html[data-theme="light"]').waitFor();
      if (name === 'perspective')
        await editor.locator('perspective-viewer').evaluate(element => element.flush());
      await editor
        .getByRole('button', {
          name: name === 'univer' ? '导出 XLSX' : '导出 CSV',
          exact: true,
        })
        .click();
      await page.waitForFunction(() => globalThis.download);
      await page.screenshot({
        path: join(reports, 'screenshots', `${name}.png`),
      });
      await page.reload();
      await editor.locator('#status').filter({ hasText: '已保存' }).waitFor({ timeout: 90000 });
      assert.equal(await editor.locator('.title').inputValue(), `${name} edited`);
      await editor.locator('.title:not(:disabled)').waitFor();
      await editor.locator('.title').fill('Unsaved title');
      await editor.getByRole('button', { name: '文档', exact: true }).click();
      await editor.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
      assert.equal(await editor.locator('.title').inputValue(), 'Unsaved title');
      await editor.getByRole('button', { name: '文档', exact: true }).click();
      await editor
        .getByRole('dialog')
        .getByRole('button', { name: '放弃修改', exact: true })
        .click();
      await editor.locator('#library .document').first().waitFor();
      await editor.locator('.title:not(:disabled)').waitFor();
      await editor.locator('#file').setInputFiles({
        name: '导入验证.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from('编号,金额\n001,120\n002,240'),
      });
      await editor.locator('#status').filter({ hasText: '已保存' }).waitFor();
      await editor.locator('.title:not(:disabled)').waitFor();
      assert.equal(await editor.locator('.title').inputValue(), '导入验证');
      await page.setViewportSize({ width: 420, height: 790 });
      await editor.locator('#file').setInputFiles({
        name: '无效.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from('编号,金额\n"unterminated,120'),
      });
      await editor.locator('#status.error').waitFor({ state: 'visible' });
      assert.equal(await editor.locator('.title').inputValue(), '导入验证');
      const headerFits = await editor
        .locator('body > header')
        .evaluate(element => element.scrollWidth <= element.clientWidth);
      assert.ok(headerFits, 'An error must remain visible without hiding narrow-screen actions');
      await page.screenshot({
        path: join(reports, 'screenshots', `${name}-narrow-error.png`),
      });
      await page.setViewportSize({ width: 900, height: 790 });
      await editor.locator('#editor').evaluate(element => {
        globalThis.originalEditor = element.firstElementChild;
      });
      const calls = await page.evaluate(() => globalThis.businessCalls);
      const toolbar = editor.locator('[data-app-toolbar]');
      const status = toolbar.locator('#status');
      const errorText = await status.textContent();
      for (let attempt = 0; attempt < 2; attempt++) {
        await page.evaluate(() =>
          globalThis.bridge.setHostContext({
            'ui/shared-header': { height: 44, left: 180, right: 96 },
          }),
        );
        await editor.locator('html[data-shared-header]').waitFor();
      }
      assert.equal(await editor.locator('.title').isVisible(), false);
      assert.equal(await toolbar.evaluate(el => el.offsetHeight), 44);
      assert.equal(await status.isVisible(), true);
      assert.equal(await status.textContent(), errorText);
      await editor
        .locator('[data-app-toolbar]')
        .getByRole('button', { name: '重命名', exact: true })
        .click();
      await editor.getByRole('dialog').getByRole('textbox').fill('取消的重命名');
      await editor.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
      assert.equal(await editor.locator('.title').inputValue(), '导入验证');
      await editor
        .locator('[data-app-toolbar]')
        .getByRole('button', { name: '重命名', exact: true })
        .click();
      await editor.getByRole('dialog').getByRole('textbox').fill('共享标题栏验证');
      await editor.getByRole('dialog').getByRole('button', { name: '确定', exact: true }).click();
      assert.equal(await editor.locator('.title').inputValue(), '共享标题栏验证');
      assert.equal(await status.textContent(), '未保存');
      assert.equal(await page.evaluate(() => globalThis.businessCalls), calls);
      await editor.getByRole('button', { name: '保存', exact: true }).click();
      await status.filter({ hasText: '已保存' }).waitFor();
      const library = await client.callTool({ name: 'list_documents', arguments: {} });
      assert.ok(library.structuredContent.documents.some(item => item.title === '共享标题栏验证'));
      await page.screenshot({
        path: join(reports, 'screenshots', `${name}-shared-header.png`),
      });
      await page.evaluate(() => globalThis.bridge.setHostContext({ 'ui/shared-header': null }));
      await editor.locator('html:not([data-shared-header])').waitFor();
      assert.equal(await editor.locator('.title').isVisible(), true);
      assert.equal(await editor.locator('.title').inputValue(), '共享标题栏验证');
      assert.ok(
        await editor
          .locator('#editor')
          .evaluate(el => el.firstElementChild === globalThis.originalEditor),
        'Shared header transitions must preserve the live editor instance',
      );
      assert.deepEqual(errors, []);
      await writeFile(
        join(reports, `${name}-ui-proof.json`),
        JSON.stringify(
          {
            name,
            persistedRevision: persisted.structuredContent.revision,
            requests,
            errors,
          },
          null,
          2,
        ),
      );
      console.log(`${name}: real UI loaded, saved, exported and restored; no public requests`);
    } catch (error) {
      await page.screenshot({
        path: join(reports, 'screenshots', `${name}-failure.png`),
      });
      console.error(name, errors);
      throw error;
    } finally {
      await context.close();
      await new Promise(resolve => server.close(resolve));
      await client.close();
      assert.ok(resolve(dir).startsWith(join(tmpdir(), 'mcp-app-ui-')));
      await rm(dir, { recursive: true, force: true });
    }
  }
} finally {
  await browser.close();
}
