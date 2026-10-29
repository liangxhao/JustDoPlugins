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
    const directory = resolve('plugins', 'extensions', name, 'dist');
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
      await cp(resolve('plugins', 'extensions', name, 'dist'), join(dir, 'package'), {
        recursive: true,
      });
      client = await connect(name, dir);
      const { tools } = await client.listTools();
      const entry = tools.find(tool => tool.name === 'open_editor');
      for (const tool of tools) {
        assert.deepEqual(
          tool.icons.map(icon => icon.theme),
          ['light', 'dark'],
        );
        for (const icon of tool.icons) {
          assert.equal(icon.mimeType, 'image/svg+xml');
          assert.match(decodeURIComponent(icon.src.split(',')[1]), /<svg.*<\/svg>/);
        }
      }
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
      assert.equal((await fetch(editorUrl, { method: 'POST' })).status, 404);
      const invalidArgs = await client.callTool({
        name: 'open_editor',
        arguments: { path: '../secret' },
      });
      assert.equal(invalidArgs.isError, true);
      if (name === 'perspective') {
        const fileEntry = tools.find(tool => tool.name === 'preview_file');
        assert.deepEqual(fileEntry._meta['openai/ui'].entrypoints, [
          { type: 'file', extensions: ['.csv', '.tsv', '.json', '.ndjson', '.jsonl', '.arrow', '.feather'] },
        ]);
      }
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
          assert.match(rejected.content[0].text, /Worksheet not found|Invalid worksheet ID/, sheetId);
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
      if (name === 'univer') {
        const range = await client.callTool({
          name: 'read_range',
          arguments: {
            id: document.id,
            sheetId: 'sheet1',
            startRow: 3,
            startColumn: 1,
            rowCount: 1,
            columnCount: 1,
          },
        });
        assert.equal(range.structuredContent.revision, 3);
        assert.equal(range.structuredContent.cells[0][0].formula, '=SUM(B2:B3)');
      } else {
        const configured = await client.callTool({
          name: 'configure_analysis',
          arguments: {
            id: document.id,
            expectedRevision: 2,
            config: { group_by: ['部门'], columns: ['金额'], aggregates: { 金额: 'sum' } },
          },
        });
        assert.equal(configured.structuredContent.revision, 3);
        const appended = await client.callTool({
          name: 'append_data',
          arguments: {
            id: document.id,
            expectedRevision: 3,
            rows: [{ 部门: '研发', 金额: 400 }],
          },
        });
        assert.equal(appended.structuredContent.revision, 4);
        const read = await client.callTool({
          name: 'read_analysis',
          arguments: {
            id: document.id,
            offset: 1,
            limit: 1,
          },
        });
        assert.equal(read.structuredContent.rowCount, 3);
        assert.deepEqual(read.structuredContent.rows, [{ 部门: '运营', 金额: 300 }]);
        assert.equal(read.structuredContent.hasMore, true);
        assert.deepEqual(read.structuredContent.schema, { 部门: 'string', 金额: 'float' });
        assert.deepEqual(read.structuredContent.config.group_by, ['部门']);
        const invalidConfig = await client.callTool({
          name: 'configure_analysis',
          arguments: {
            id: document.id,
            expectedRevision: 4,
            config: { group_by: ['missing'] },
          },
        });
        assert.equal(invalidConfig.isError, true);
        const invalidRows = await client.callTool({
          name: 'append_data',
          arguments: {
            id: document.id,
            expectedRevision: 4,
            rows: [{ 部门: '研发', 金额: 'wrong type' }],
          },
        });
        assert.equal(invalidRows.isError, true);
        assert.equal(
          (await client.callTool({ name: 'read_analysis', arguments: { id: document.id } }))
            .structuredContent.revision,
          4,
        );
      }
      const unknown = await client.callTool({
        name: 'open_document',
        arguments: { id: '../secrets' },
      });
      assert.equal(unknown.isError, true);
      const integrity = JSON.parse(
        await readFile(resolve('plugins', 'extensions', name, 'dist/integrity.json'), 'utf8'),
      );
      assert.ok(integrity.assets['app.html']);
    } finally {
      await client?.close();
      assert.ok(resolve(dir).startsWith(join(tmpdir(), 'mcp-app-test-')));
      await rm(dir, { recursive: true, force: true });
    }
  });

  test(`${name}: saved page reads enforce a UTF-8 byte limit`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-app-query-limit-'));
    let client;
    try {
      await cp(resolve('plugins', 'extensions', name, 'dist'), join(dir, 'package'), {
        recursive: true,
      });
      client = await connect(name, dir);
      const text = '汉'.repeat(32768);
      const created = await client.callTool(
        name === 'univer'
          ? {
              name: 'create_spreadsheet',
              arguments: {
                title: 'Large text',
                columns: ['x'],
                rows: Array.from({ length: 20 }, () => [text]),
              },
            }
          : {
              name: 'analyze_data',
              arguments: {
                title: 'Large text',
                rows: Array.from({ length: 20 }, () => ({ x: text })),
              },
            },
      );
      assert.ok(!created.isError, JSON.stringify(created));
      const id = created.structuredContent.id;
      const tool = name === 'univer' ? 'read_range' : 'read_analysis';
      const argumentsFor = count =>
        name === 'univer'
          ? { id, sheetId: 'sheet1', startRow: 1, rowCount: count, columnCount: 1 }
          : { id, limit: count };
      const large = await client.callTool({ name: tool, arguments: argumentsFor(20) });
      assert.equal(large.isError, true);
      assert.match(large.content[0].text, /256 KiB/);
      const small = await client.callTool({ name: tool, arguments: argumentsFor(1) });
      assert.ok(!small.isError, JSON.stringify(small));
      assert.ok(Buffer.byteLength(JSON.stringify(small.structuredContent)) <= 256 * 1024);
      assert.equal(
        name === 'univer'
          ? small.structuredContent.cells[0][0].value
          : small.structuredContent.rows[0].x,
        text,
      );
      if (name === 'perspective') {
        const configured = await client.callTool({
          name: 'replace_data',
          arguments: {
            id,
            expectedRevision: 1,
            rows: [{ x: text }],
            config: { filter: [['x', 'in', Array(10).fill(text)]] },
          },
        });
        assert.ok(!configured.isError, JSON.stringify(configured));
        assert.equal(
          (await client.callTool({ name: tool, arguments: { id, limit: 1 } })).isError,
          true,
        );
        const withoutConfig = await client.callTool({
          name: tool,
          arguments: {
            id,
            limit: 1,
            includeConfig: false,
          },
        });
        assert.ok(!withoutConfig.isError, JSON.stringify(withoutConfig));
        assert.equal(withoutConfig.structuredContent.configOmitted, true);
        assert.equal(withoutConfig.structuredContent.config, undefined);
        assert.equal(withoutConfig.structuredContent.rows[0].x, text);
      }
    } finally {
      await client?.close();
      assert.ok(resolve(dir).startsWith(join(tmpdir(), 'mcp-app-query-limit-')));
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test('perspective: all writes validate real engine semantics before persistence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-app-validation-'));
  let client;
  try {
    // The copied directory has no development dependencies or node_modules.
    await cp(resolve('plugins/extensions/perspective/dist'), join(dir, 'package'), {
      recursive: true,
    });
    client = await connect('perspective', dir);
    const rows = [{ x: 1, y: 'a' }];
    const created = await client.callTool({
      name: 'analyze_data',
      arguments: { title: 'Valid', rows },
    });
    assert.ok(!created.isError, JSON.stringify(created));
    const id = created.structuredContent.id;
    const invalid = [
      { aggregates: { x: 'this-is-not-an-aggregate' } },
      { filter: [['x', 'not-a-filter', 1]] },
      { expressions: { broken: 'nonexistent(' } },
      { plugin: 'nonexistent-review-plugin' },
      { plugin_config: { edit_mode: 'INVALID' } },
      { columns_config: { x: { fg_color: 42 } } },
      { plugin: 'Y Bar', plugin_config: { facet_mode: 'invalid' } },
      { columns_config: { x: { number_format: { style: 'invalid' } } } },
      { columns_config: { x: { fg_color: 'red' } } },
      { columns_config: { x: { fg_color: 'linear-gradient(to right, rgb(0xff 0 0), #00ff00)' } } },
      { columns_config: { x: { fg_color: 'linear-gradient(edeg, #ff0000, #00ff00)' } } },
      {
        group_by: ['x'],
        columns: ['x'],
        columns_config: { x: { fg_mode: 'bar', fg_color: '#ff0000' } },
      },
      {
        columns_config: { x: { fg_color: 'linear-gradient(to right, #ff0000 1px, #00ff00 100%)' } },
      },
    ];
    for (const config of invalid) {
      const rejected = await client.callTool({
        name: 'configure_analysis',
        arguments: {
          id,
          expectedRevision: 1,
          config,
        },
      });
      assert.equal(rejected.isError, true, JSON.stringify(config));
      const persisted = await client.callTool({ name: 'read_document', arguments: { id } });
      assert.equal(persisted.structuredContent.revision, 1);
      assert.deepEqual(persisted.structuredContent.data.config, {});
    }
    const config = invalid[0];
    for (const request of [
      { name: 'analyze_data', arguments: { title: 'Invalid', rows, config } },
      { name: 'import_document', arguments: { title: 'Invalid', data: { rows, config } } },
      {
        name: 'save_document',
        arguments: { id, expectedRevision: 1, title: 'Invalid', data: { rows, config } },
      },
      { name: 'replace_data', arguments: { id, expectedRevision: 1, rows, config } },
    ])
      assert.equal((await client.callTool(request)).isError, true, request.name);
    const library = await client.callTool({ name: 'list_documents' });
    assert.deepEqual(
      library.structuredContent.documents.map(item => item.id),
      [id],
    );
    // A rejected WASM configuration must not poison later valid work. The CAS
    // happens after preflight, so concurrent validations cannot lose an update.
    const writes = await Promise.all(
      ['asc', 'desc'].map(direction =>
        client.callTool({
          name: 'configure_analysis',
          arguments: { id, expectedRevision: 1, config: { sort: [['x', direction]] } },
        }),
      ),
    );
    assert.equal(writes.filter(result => !result.isError).length, 1);
    assert.match(writes.find(result => result.isError).content[0].text, /CONFLICT/);
    const persisted = await client.callTool({ name: 'read_document', arguments: { id } });
    assert.equal(persisted.structuredContent.revision, 2);
    assert.equal(persisted.structuredContent.title, 'Valid');
    const styled = await client.callTool({
      name: 'configure_analysis',
      arguments: {
        id,
        expectedRevision: 2,
        config: {
          plugin: 'Datagrid',
          plugin_config: { edit_mode: 'EDIT', font_size: 16, zebra_rows: 1 },
          columns_config: {
            x: {
              fg_mode: 'bar',
              fg_color: 'linear-gradient(to right, #ff0000 0%, #00ff00 100%)',
              number_format: { style: 'currency', currency: 'USD' },
            },
          },
        },
      },
    });
    assert.ok(!styled.isError, JSON.stringify(styled));
    assert.equal(styled.structuredContent.revision, 3);
    const switched = await client.callTool({
      name: 'configure_analysis',
      arguments: {
        id,
        expectedRevision: 3,
        config: { plugin: 'Y Bar', plugin_config: { facet_mode: 'grid' } },
      },
    });
    assert.ok(!switched.isError, 'Changing plugins must retain valid hidden column styles');
    const cleared = await client.callTool({
      name: 'replace_data',
      arguments: {
        id,
        expectedRevision: 4,
        rows: [{ x: null, y: 'a' }],
        config: { plugin: 'Datagrid', group_by: ['y'], columns: ['x'], aggregates: { x: 'sum' } },
      },
    });
    assert.ok(!cleared.isError, JSON.stringify(cleared));
    const emptyValues = await client.callTool({ name: 'read_analysis', arguments: { id } });
    assert.equal(emptyValues.structuredContent.schema.x, 'float');
    assert.equal(emptyValues.structuredContent.rows[0].x, null);
  } finally {
    await client?.close();
    assert.ok(resolve(dir).startsWith(join(tmpdir(), 'mcp-app-validation-')));
    await rm(dir, { recursive: true, force: true });
  }
});

test('perspective: cancelling validation never creates or overwrites documents', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-app-cancel-'));
  let client;
  const cancel = async request => {
    const controller = new AbortController();
    const pending = client.callTool(request, undefined, { signal: controller.signal });
    const timer = setTimeout(() => controller.abort(), 10);
    try {
      await assert.rejects(pending);
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    await cp(resolve('plugins/extensions/perspective/dist'), join(dir, 'package'), {
      recursive: true,
    });
    client = await connect('perspective', dir);
    const rows = [{ x: 1 }];
    await cancel({ name: 'analyze_data', arguments: { title: 'Cancelled create', rows } });
    // A valid request after cancellation waits for its own engine validation.
    const valid = await client.callTool({
      name: 'analyze_data',
      arguments: { title: 'Keep', rows },
    });
    assert.ok(!valid.isError, JSON.stringify(valid));
    const id = valid.structuredContent.id;
    assert.deepEqual(
      (await client.callTool({ name: 'list_documents' })).structuredContent.documents.map(
        item => item.id,
      ),
      [id],
    );
    await client.close();
    client = await connect('perspective', dir); // cold worker makes the cancellation window deterministic
    await cancel({
      name: 'save_document',
      arguments: {
        id,
        expectedRevision: 1,
        title: 'Cancelled overwrite',
        data: { rows: [{ x: 999 }], config: {} },
      },
    });
    const verified = await client.callTool({
      name: 'analyze_data',
      arguments: { title: 'After cancel', rows },
    });
    assert.ok(!verified.isError, JSON.stringify(verified));
    const persisted = await client.callTool({ name: 'read_document', arguments: { id } });
    assert.equal(persisted.structuredContent.revision, 1);
    assert.equal(persisted.structuredContent.title, 'Keep');
    assert.deepEqual(persisted.structuredContent.data.rows, rows);
  } finally {
    await client?.close();
    assert.ok(resolve(dir).startsWith(join(tmpdir(), 'mcp-app-cancel-')));
    await rm(dir, { recursive: true, force: true });
  }
});
