import assert from 'node:assert/strict';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { subMillisecondTimestampArrow, wrappedSecondsTimestampArrow } from './fixtures/perspective-submillisecond.mjs';

test('Perspective rejects lossy filters, wrong legacy targets and invalid empty-workspace filters before writes', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perspective-review-regression-'));
  let client;
  try {
    await cp(resolve('plugins/extensions/perspective/dist'), join(directory, 'package'), { recursive: true });
    client = new Client({ name: 'Perspective independent review regression', version: '1' });
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [join(directory, 'package/server.cjs')],
      env: { ...process.env, MCP_APP_DATA_DIR: join(directory, 'data') },
      stderr: 'pipe',
    }));
    const call = (name, input) => client.callTool({ name, arguments: input });
    const ok = async (name, input) => {
      const result = await call(name, input);
      assert.ok(!result.isError, JSON.stringify(result));
      return result.structuredContent;
    };
    const rejected = async (name, input, pattern) => {
      const result = await call(name, input);
      assert.equal(result.isError, true, `${name} accepted an invalid write: ${JSON.stringify(result)}`);
      assert.match(JSON.stringify(result), pattern);
    };
    const created = await ok('analyze_data', {
      title: 'Independent filter regression', rows: [{ x: 1 }], schema: { x: 'integer' },
    });
    const before = await ok('read_document', { id: created.id });
    for (const config of [
      { filter: [['x', '==', 1.5]] },
      { filter: [['x', 'in', [1, 1.5]]] },
      { expressions: { alias: '"x"' }, filter: [['alias', '==', 1.5]] },
    ]) {
      await rejected('configure_analysis', { id: created.id, expectedRevision: 1, config }, /integer|type|precision/i);
      assert.deepEqual(await ok('read_document', { id: created.id }), before,
        'An integer filter must not silently truncate or advance the saved revision');
    }
    await rejected('replace_data', {
      id: created.id, expectedRevision: 1, rows: [{ x: 2 }], panelId: 'missing', config: { columns: ['x'] },
    }, /Unknown analysis panel/i);
    assert.deepEqual(await ok('read_document', { id: created.id }), before,
      'A nonexistent legacy target must not overwrite the main source');
    await rejected('import_analysis', {
      title: 'Submillisecond Arrow', format: 'arrow', blob: subMillisecondTimestampArrow,
    }, /millisecond|timestamp|precision|unit/i);
    await rejected('import_analysis', {
      title: 'Wrapped second Arrow', format: 'arrow', blob: wrappedSecondsTimestampArrow,
    }, /timestamp|range|precision|epoch|limit/i);
    await rejected('analyze_data', {
      title: 'Invalid empty workspace', rows: [{ x: 1 }],
      workspace: { panels: {}, global_filters: [['x', 'invalid-operator', 1]] },
    }, /filter|operator/i);
    assert.equal((await ok('list_documents', {})).documents.length, 1,
      'Invalid filters in an empty workspace must fail before creating a document');
    const empty = await ok('analyze_data', {
      title: 'Valid empty workspace', rows: [{ x: 1 }], workspace: { panels: {} },
    });
    await ok('inspect_analysis', { id: empty.id });
  } finally {
    await client?.close();
    assert.equal(dirname(directory), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('perspective-review-regression-'));
    await rm(directory, { recursive: true, force: true });
  }
});
