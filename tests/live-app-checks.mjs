import assert from 'node:assert/strict';

/** Exercise real editor state through the public AppBridge, rather than mocked model results. */
export async function verifyLiveApp(page, frame, client, name) {
  const call = (tool, args = {}) =>
    page.evaluate(params => globalThis.bridge.callTool(params), { name: tool, arguments: args });
  const prefix = name === 'univer' ? 'spreadsheet' : 'analysis';
  const { tools } = await page.evaluate(() => globalThis.bridge.listTools({}));
  assert.equal(
    tools.find(tool => tool.name === 'prepare_context')._meta['workspace/prepare-context'],
    true,
  );
  assert.equal(tools.find(tool => tool.name === `${prefix}_apply`).annotations.readOnlyHint, false);
  const originalElement = await frame.locator('#editor').evaluate(element => {
    globalThis.liveOriginalEditor = element.firstElementChild;
    return Boolean(globalThis.liveOriginalEditor);
  });
  assert.ok(originalElement);
  if (name === 'perspective') {
    const plugins = await frame.locator('perspective-viewer').evaluate(element =>
      element
        .getAllPlugins()
        .map(plugin => plugin.get_static_config().name)
        .sort(),
    );
    const appTools = await page.evaluate(() => globalThis.bridge.listTools({}));
    const allowed = appTools.tools
      .find(tool => tool.name === 'analysis_apply')
      .inputSchema.properties.patch.properties.config.properties.plugin.anyOf.find(
        schema => schema.enum,
      )?.enum;
    assert.deepEqual(
      plugins,
      [...allowed].sort(),
      'Config validation must match bundled viewer plugins',
    );
    const canvas = await frame.locator('perspective-viewer').boundingBox();
    assert.ok(
      canvas && canvas.width > 250 && canvas.height > 300,
      'The actual Perspective viewer must occupy the visible editor area',
    );
    const table = frame.locator('perspective-viewer regular-table').first();
    await table.waitFor({ state: 'visible' });
  }
  await frame.locator('.title').fill('Live unsaved draft');
  const before = (await call(`${prefix}_snapshot`)).structuredContent;
  assert.equal(before.dirty, true);
  assert.equal(before.title, 'Live unsaved draft');
  await page.evaluate(
    reference => globalThis.bridge.sendToolResult({ content: [], structuredContent: reference }),
    { id: before.documentId, revision: before.revision },
  );
  await frame.locator('.title:not(:disabled)').waitFor();
  assert.equal(
    await frame.locator('dialog').count(),
    0,
    'A repeated result must not interrupt unsaved work',
  );
  assert.equal(await frame.locator('.title').inputValue(), 'Live unsaved draft');
  const savedBefore = await client.callTool({
    name: 'read_document',
    arguments: { id: before.documentId },
  });
  const businessCalls = await page.evaluate(() => globalThis.businessCalls);
  const prepared = await call('prepare_context');
  assert.equal(prepared.structuredContent.prepared, true);
  const context = await page.evaluate(() => globalThis.context);
  const shared = JSON.parse(context.content[0].text);
  assert.equal(shared.title, 'Live unsaved draft');
  assert.equal(shared.documentId, before.documentId);
  assert.ok(Buffer.byteLength(context.content[0].text) <= 16000);
  const patch =
    name === 'univer'
      ? {
          sheetId: 'sheet1',
          cells: [
            { row: 1, column: 1, value: 777 },
            { row: 2, column: 1, formula: '=B2*2' },
          ],
        }
      : {
          config: {
            group_by: ['编号'],
            columns: ['金额'],
            filter: [['金额', '>', 150]],
            aggregates: { 金额: 'sum' },
            plugin: 'Datagrid',
            settings: false,
          },
        };
  const input = {
    documentId: before.documentId,
    operationId: crypto.randomUUID(),
    baseContentStamp: before.contentStamp,
    patch,
  };
  await frame.locator('.title').fill('Concurrent edit');
  const conflict = await call(`${prefix}_apply`, input);
  assert.equal(conflict.isError, true);
  assert.match(conflict.content[0].text, /CONFLICT/);
  const current = (await call(`${prefix}_snapshot`)).structuredContent;
  const applied = await call(`${prefix}_apply`, {
    ...input,
    baseContentStamp: current.contentStamp,
  });
  assert.ok(!applied.isError, JSON.stringify(applied));
  assert.equal(applied.structuredContent.status, 'applied');
  assert.equal(applied.structuredContent.snapshot.documentId, before.documentId);
  assert.equal(
    await frame
      .locator('#editor')
      .evaluate(element => element.firstElementChild === globalThis.liveOriginalEditor),
    true,
  );
  const query = await call(
    `${prefix}_query`,
    name === 'univer'
      ? { sheetId: 'sheet1', startRow: 1, startColumn: 1, rowCount: 2, columnCount: 1 }
      : { limit: 10, columnLimit: 2 },
  );
  assert.ok(!query.isError, JSON.stringify(query));
  if (name === 'univer') {
    assert.equal(query.structuredContent.cells[0][0].value, 777);
    assert.equal(query.structuredContent.cells[1][0].formula, '=B2*2');
    assert.equal(query.structuredContent.cells[1][0].value, 1554);
    const canvas = frame.locator('canvas[id^="univer-sheet-main-canvas"]');
    await canvas.click({ position: { x: 160, y: 55 } });
    await page.keyboard.press('Control+z');
    const undone = await call(`${prefix}_query`, {
      sheetId: 'sheet1',
      startRow: 1,
      startColumn: 1,
      rowCount: 2,
      columnCount: 1,
    });
    assert.equal(undone.structuredContent.cells[0][0].value, '120');
    assert.equal(undone.structuredContent.cells[1][0].value, '240');
    assert.equal(
      undone.structuredContent.cells[1][0].formula,
      undefined,
      'One undo must revert the whole sparse batch',
    );
    const nameBox = frame.locator('[data-u-comp="defined-name"] input');
    await nameBox.fill('B2');
    await nameBox.press('Enter');
    await page.keyboard.type('888');
    const committed = await call('prepare_context');
    assert.ok(!committed.isError, JSON.stringify(committed));
    const active = await call(`${prefix}_query`, {
      sheetId: 'sheet1',
      startRow: 1,
      startColumn: 1,
      rowCount: 1,
      columnCount: 1,
    });
    assert.equal(
      active.structuredContent.cells[0][0].value,
      888,
      'Preparing context must commit an active cell before acknowledging',
    );
  } else {
    assert.equal(query.structuredContent.totalRows, 2);
    assert.equal(
      query.structuredContent.rows[0]['金额'],
      240,
      'Query must return the actual filtered aggregate total',
    );
    assert.deepEqual(query.structuredContent.rows[1].__ROW_PATH__, ['002']);
  }
  const fresh = (await call(`${prefix}_snapshot`)).structuredContent;
  const repeated = await call(`${prefix}_apply`, {
    ...input,
    baseContentStamp: fresh.contentStamp,
  });
  assert.equal(repeated.isError, true);
  const savedAfter = await client.callTool({
    name: 'read_document',
    arguments: { id: before.documentId },
  });
  assert.deepEqual(
    savedAfter.structuredContent,
    savedBefore.structuredContent,
    'Live editing and context preparation must not silently save',
  );
  assert.equal(
    await page.evaluate(() => globalThis.businessCalls),
    businessCalls,
    'Live tools must not re-run server business tools',
  );
  if (name === 'perspective')
    assert.ok(await page.evaluate(() => globalThis.inspectionCalls > 0), 'Live updates must reuse the read-only local engine/style preflight');
  if (name === 'perspective') {
    const stamp = (await call('analysis_snapshot')).structuredContent;
    const invalidStyle = await call('analysis_apply', {
      documentId: stamp.documentId,
      operationId: crypto.randomUUID(),
      baseContentStamp: stamp.contentStamp,
      patch: { config: { columns_config: { 金额: { number_format: { style: 'invalid' } } } } },
    });
    assert.equal(invalidStyle.isError, true, 'Invalid number formats must fail before rendering');
    const freshStyle = (await call('analysis_snapshot')).structuredContent;
    const styled = await call('analysis_apply', {
      documentId: freshStyle.documentId,
      operationId: crypto.randomUUID(),
      baseContentStamp: freshStyle.contentStamp,
      patch: {
        config: {
          plugin_config: { edit_mode: 'EDIT', font_size: 16, zebra_rows: 1 },
          columns_config: {
            金额: {
              fg_mode: 'bar',
              fg_color: 'linear-gradient(to right, #ff0000 0%, #00ff00 100%)',
              number_format: { style: 'currency', currency: 'USD' },
            },
          },
        },
      },
    });
    assert.ok(!styled.isError, JSON.stringify(styled));
    await frame.locator('[data-action="save"]').click();
    const status = frame.locator('[data-app-toolbar] #status');
    await status.filter({ hasText: /^已保存$/ }).waitFor();
    // This is the public table operation used by Datagrid's cell editor. The
    // source snapshot must follow data updates, including all-null columns.
    await frame.locator('perspective-viewer').evaluate(async element => {
      const table = await element.getTable();
      await table.update([
        { __INDEX__: 0, 金额: null },
        { __INDEX__: 1, 金额: null },
      ]);
      await element.flush();
    });
    await status.filter({ hasText: '未保存' }).waitFor();
    const edited = (await call('analysis_snapshot')).structuredContent;
    assert.equal(edited.dirty, true);
    assert.equal(
      edited.schema['金额'],
      'float',
      'Clearing a column must preserve its numeric type',
    );
    await frame.locator('[data-action="save"]').click();
    await status.filter({ hasText: /^已保存$/ }).waitFor();
    const saved = await client.callTool({
      name: 'read_document',
      arguments: { id: edited.documentId },
    });
    assert.equal(saved.structuredContent.data.schema['金额'], 'float');
    assert.deepEqual(
      saved.structuredContent.data.rows.map(row => row['金额']),
      [null, null],
    );
    assert.equal(saved.structuredContent.data.config.plugin_config.font_size, 16);
    await frame.locator('[data-action="reload"]').click();
    await frame.locator('.title:not(:disabled)').waitFor();
    const restored = await call('analysis_snapshot');
    assert.ok(!restored.isError, JSON.stringify(restored));
    assert.equal(restored.structuredContent.dirty, false);
    assert.equal(restored.structuredContent.schema['金额'], 'float');
  }
  await page.evaluate(() => globalThis.bridge.teardownResource({}));
  assert.equal((await call(`${prefix}_snapshot`)).isError, true);
}
