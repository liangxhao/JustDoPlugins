import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function connect(name, dir) {
  const client = new Client({ name: 'apps-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(dir, 'package/server.cjs')],
    env: { ...process.env, MCP_APP_DATA_DIR: dir },
    stderr: 'pipe',
  });
  await client.connect(transport);
  return client;
}
for (const name of ['univer', 'perspective']) {
  test(`${name}: bundled dependencies include complete license notices`, async () => {
    const directory = resolve('plugins', name, 'dist');
    const notices = JSON.parse(await readFile(join(directory, 'THIRD_PARTY_NOTICES.json'), 'utf8'));
    assert.ok(notices.length > 0);
    const identities = notices.map(pkg => `${pkg.name}@${pkg.version}`);
    assert.equal(new Set(identities).size, identities.length);
    if (name === 'perspective') {
      assert.ok(
        identities.includes('regular-table@0.9.2'),
        'nested table dependency is attributed',
      );
    }
    for (const pkg of notices) {
      assert.ok(pkg.notices.length > 0, `${pkg.name} must include attribution files`);
      for (const notice of pkg.notices) {
        const bytes = await readFile(join(directory, 'licenses', notice));
        assert.ok(bytes.length > 0, notice);
      }
    }
  });

  test(`${name}: actual MCP discovery, local UI, persistence and conflicting writes`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-app-test-'));
    let client;
    try {
      await cp(resolve('plugins', name, 'dist'), join(dir, 'package'), { recursive: true });
      client = await connect(name, dir);
      const { tools } = await client.listTools();
      const entry = tools.find(tool => tool.name === 'open_editor');
      assert.deepEqual(entry._meta['openai/ui'].entrypoints, [{ type: 'global' }]);
      assert.deepEqual(entry._meta.ui.visibility, ['app']);
      const { contents } = await client.readResource({ uri: entry._meta.ui.resourceUri });
      const wrapper = contents[0];
      assert.equal(wrapper.mimeType, 'text/html;profile=mcp-app');
      const editorUrl = wrapper.text.match(/src="(http[^" ]+)"/)[1];
      assert.equal(new URL(editorUrl).hostname, '127.0.0.1');
      const response = await fetch(editorUrl);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-security-policy'), /connect-src 'none'/);
      assert.match(response.headers.get('content-security-policy'), /wasm-unsafe-eval/);
      assert.equal((await fetch(new URL('/unknown', editorUrl))).status, 404);
      const create =
        name === 'univer'
          ? {
              name: 'create_spreadsheet',
              arguments: {
                title: '测试表格',
                columns: ['项目', '金额'],
                rows: [
                  ['差旅', 200],
                  ['=literal', 300],
                ],
              },
            }
          : {
              name: 'analyze_data',
              arguments: {
                title: '测试分析',
                rows: [
                  { 部门: '研发', 金额: 200 },
                  { 部门: '运营', 金额: 300 },
                ],
              },
            };
      const result = await client.callTool(create);
      assert.ok(!result.isError, JSON.stringify(result));
      assert.equal(
        result.structuredContent.data,
        undefined,
        'Views retain document references only',
      );
      const document = (
        await client.callTool({
          name: 'read_document',
          arguments: { id: result.structuredContent.id },
        })
      ).structuredContent;
      if (name === 'univer') {
        document.data.workbook.styles = { currency: { n: { pattern: '¥#,##0.00' } } };
        document.data.workbook.sheets.sheet1.cellData[3] = { 1: { v: 0, s: 'currency' } };
      }
      const otherClient = await connect(name, dir);
      try {
        const update = await client.callTool({
          name: 'save_document',
          arguments: {
            id: document.id,
            expectedRevision: 1,
            title: 'Updated',
            data: document.data,
          },
        });
        assert.equal(update.structuredContent.revision, 2);
        const conflict = await otherClient.callTool({
          name: 'save_document',
          arguments: {
            id: document.id,
            expectedRevision: 1,
            title: 'Lost update',
            data: document.data,
          },
        });
        assert.equal(conflict.isError, true);
        assert.match(conflict.content[0].text, /CONFLICT/);
      } finally {
        await otherClient.close();
      }
      if (name === 'univer') {
        for (const sheetId of ['__proto__', 'constructor', 'toString', 'missing-sheet']) {
          const rejected = await client.callTool({
            name: 'update_cells',
            arguments: {
              id: document.id,
              expectedRevision: 2,
              sheetId,
              cells: [{ row: 3, column: 1, value: 'invalid worksheet' }],
            },
          });
          assert.equal(rejected.isError, true, sheetId);
          assert.match(rejected.content[0].text, /Worksheet not found/, sheetId);
          const unchanged = await client.callTool({
            name: 'read_document',
            arguments: { id: document.id },
          });
          assert.equal(unchanged.structuredContent.revision, 2, sheetId);
          assert.equal(unchanged.structuredContent.data.workbook.sheets.sheet1.cellData[3][1].v, 0);
        }
        const update = await client.callTool({
          name: 'update_cells',
          arguments: {
            id: document.id,
            expectedRevision: 2,
            sheetId: 'sheet1',
            cells: [{ row: 3, column: 1, formula: '=SUM(B2:B3)' }],
          },
        });
        assert.equal(
          (await client.callTool({ name: 'read_document', arguments: { id: document.id } }))
            .structuredContent.data.workbook.sheets.sheet1.cellData[3][1].f,
          '=SUM(B2:B3)',
        );
        assert.ok(!update.isError);
        const updated = await client.callTool({
          name: 'read_document',
          arguments: { id: document.id },
        });
        assert.equal(updated.structuredContent.data.workbook.sheets.sheet1.cellData[2][0].t, 1);
        assert.equal(
          updated.structuredContent.data.workbook.sheets.sheet1.cellData[3][1].s,
          'currency',
        );
      }
      await client.close();
      client = await connect(name, dir);
      const restored = await client.callTool({
        name: 'open_document',
        arguments: { id: document.id },
      });
      assert.equal(restored.structuredContent.title, 'Updated');
      assert.equal(restored.structuredContent.revision, name === 'univer' ? 3 : 2);
      const unknown = await client.callTool({
        name: 'open_document',
        arguments: { id: '../secrets' },
      });
      assert.equal(unknown.isError, true);
      const integrity = JSON.parse(
        await readFile(resolve('plugins', name, 'dist/integrity.json'), 'utf8'),
      );
      assert.ok(integrity.assets['app.html']);
    } finally {
      await client?.close();
      assert.ok(resolve(dir).startsWith(join(tmpdir(), 'mcp-app-test-')));
      await rm(dir, { recursive: true, force: true });
    }
  });
}
