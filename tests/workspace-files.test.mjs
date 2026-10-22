import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

const built = await build({
  entryPoints: ['plugins/extensions/univer/workspace-files.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  plugins: [
    {
      name: 'sdk-test-boundary',
      setup(builder) {
        builder.onResolve({ filter: /^openclaw\/plugin-sdk\// }, args => ({
          path: args.path,
          namespace: 'sdk',
        }));
        builder.onLoad({ filter: /.*/, namespace: 'sdk' }, () => ({
          contents: `
      export const root = (...a) => globalThis.fileSdk.root(...a);
      export const readRegularFileSync = (...a) => globalThis.fileSdk.readRegularFileSync(...a);
      export const getSessionEntry = (...a) => globalThis.fileSdk.getSessionEntry(...a);
      export const dispatchGatewayMethod = (...a) => globalThis.fileSdk.dispatchGatewayMethod(...a);
      export const getAgentWorkspaceAccess = (...a) => globalThis.fileSdk.getAgentWorkspaceAccess(...a);
      export const loadAgentHarnessMcpConfig = (...a) => globalThis.fileSdk.loadAgentHarnessMcpConfig(...a);
    `,
        }));
      },
    },
  ],
});
const { registerWorkspaceFiles } = await import(
  `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text + '\n//# sourceURL=workspace-file-fixture.mjs').toString('base64')}`
);

function fixture() {
  const entry = {
    sessionId: 'incarnation',
    lifecycleRevision: 7,
    spawnedCwd: resolve('workspace'),
  };
  const config = { mcp: { apps: { enabled: true } }, plugins: { entries: {} } };
  const calls = [];
  const handlers = new Map(),
    backups = new Map();
  let response,
    content = Buffer.from('spreadsheet');
  const writes = [];
  globalThis.fileSdk = {
    readRegularFileSync: () => ({ buffer: Buffer.from(content) }),
    root: async directory =>
      directory === resolve('state')
        ? {
            write: async (name, bytes) => backups.set(name, Buffer.from(bytes)),
          }
        : {
            read: async () => ({ buffer: Buffer.from(content) }),
            write: async (name, bytes, options) => {
              options.assertBeforeMutation?.();
              writes.push(name);
              content = Buffer.from(bytes);
            },
          },
    getSessionEntry: () => structuredClone(entry),
    getAgentWorkspaceAccess: () => undefined,
    loadAgentHarnessMcpConfig: async () => ({ pluginIdsByServer: { univer: 'univer-app' } }),
    dispatchGatewayMethod: async (method, params) => {
      calls.push({ method, params });
      if (method === 'sessions.describe')
        return { ok: true, payload: { session: { sessionId: entry.sessionId } } };
      if (method === 'sessions.files.list')
        return { ok: true, payload: { root: resolve('workspace') } };
      if (method === 'mcp.app.launch')
        return { ok: true, payload: { viewId: 'mcp-app-file', preview: {} } };
      if (method === 'mcp.app.view') return { ok: true, payload: { messageSupported: true } };
      if (method === 'mcp.app.callTool')
        return { ok: true, payload: { structuredContent: { authorized: true } } };
      throw new Error(`Unexpected method: ${method}`);
    },
  };
  registerWorkspaceFiles({
    runtime: {
      config: { current: () => config },
      state: { resolveStateDir: () => resolve('state') },
    },
    registerGatewayMethod(method, fn) {
      handlers.set(method, fn);
    },
  });
  return {
    entry,
    config,
    calls,
    backups,
    writes,
    get content() {
      return content;
    },
    set content(value) {
      content = Buffer.from(value);
    },
    async resource(overrides = {}, authority = () => true) {
      const stage = calls.find(call => call.method === 'mcp.app.callTool');
      await handlers.get('mcp-app-files.resource.univer')({
        params: {
          sessionKey: 'agent:main:test',
          sessionId: 'incarnation',
          agentId: 'main',
          viewId: 'mcp-app-file',
          action: 'read',
          uri: `app-file://${stage?.params.arguments.token}`,
          ...overrides,
        },
        respond: (...result) => {
          response = result;
        },
        hasCurrentClientAuthority: authority,
      });
      return response;
    },
    async run(overrides = {}, authority = () => true) {
      await handlers.get('mcp-app-files.open.univer')({
        params: {
          sessionKey: 'agent:main:test',
          sessionId: 'incarnation',
          agentId: 'main',
          filePath: resolve('workspace/budget.xlsx'),
          serverName: 'univer',
          toolName: 'preview_file',
          entrypointType: 'file',
          ...overrides,
        },
        respond: (...result) => {
          response = result;
        },
        hasCurrentClientAuthority: authority,
      });
      return response;
    },
  };
}

test('file opener publishes only a fully staged native view', async () => {
  const f = fixture();
  const [ok, result] = await f.run();
  assert.equal(ok, true);
  assert.equal(result.viewId, 'mcp-app-file');
  const launch = f.calls.find(call => call.method === 'mcp.app.launch');
  const staged = f.calls.find(call => call.method === 'mcp.app.callTool');
  assert.equal(launch.params.entrypointType, 'global');
  assert.match(launch.params.deepLink, /^\/workspace-file\/[a-f0-9]{64}$/);
  assert.equal(staged.params.viewId, result.viewId);
  assert.equal(staged.params.arguments.blob, Buffer.from('spreadsheet').toString('base64'));
});

test('file opener refuses stale identity, outside paths, remote workspaces and overridden MCP owners', async () => {
  for (const scenario of [
    'identity',
    'outside',
    'remote',
    'override',
    'shadow',
    'disabled',
    'authority',
  ]) {
    const f = fixture();
    let params = {};
    if (scenario === 'identity') params.sessionId = 'old';
    if (scenario === 'outside') params.filePath = resolve('outside.xlsx');
    if (scenario === 'remote') f.entry.execNode = 'remote';
    if (scenario === 'override')
      f.config.mcp.servers = { univer: { url: 'https://example.invalid/mcp' } };
    if (scenario === 'shadow')
      globalThis.fileSdk.loadAgentHarnessMcpConfig = async () => ({
        pluginIdsByServer: { univer: 'other-plugin' },
      });
    if (scenario === 'disabled') f.config.plugins.entries['univer-app'] = { enabled: false };
    const [ok] = await f.run(params, () => scenario !== 'authority');
    assert.equal(ok, false, scenario);
    assert.ok(!f.calls.some(call => call.method.startsWith('mcp.app.')), scenario);
  }
});

test('file opener drops file bytes when the native lifecycle rotates during read', async () => {
  const f = fixture();
  globalThis.fileSdk.root = async () => ({
    read: async () => {
      f.entry.lifecycleRevision++;
      return { buffer: Buffer.from('private data') };
    },
  });
  assert.equal((await f.run())[0], false);
  assert.ok(!f.calls.some(call => call.method === 'mcp.app.callTool'));
});

test('file opener never retries a tool with an unknown completion', async () => {
  const f = fixture();
  const dispatch = globalThis.fileSdk.dispatchGatewayMethod;
  let stages = 0;
  globalThis.fileSdk.dispatchGatewayMethod = async (method, params) => {
    if (method === 'mcp.app.callTool') {
      stages++;
      throw new Error('request timeout');
    }
    return dispatch(method, params);
  };
  assert.equal((await f.run())[0], false);
  assert.equal(stages, 1);
});

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
test('source save uses native write approval, backs up original bytes and returns a new revision', async () => {
  const f = fixture();
  await f.run();
  const [ok, read] = await f.resource();
  assert.equal(ok, true);
  const etag = read.contents[0]._meta['openai/resource'].etag;
  const [saved, result] = await f.resource({
    action: 'write',
    ifMatch: etag,
    blob: Buffer.from('edited').toString('base64'),
  });
  assert.equal(saved, true);
  assert.deepEqual(result, { outcome: 'saved', etag: digest('edited') });
  assert.equal(f.content.toString(), 'edited');
  assert.equal(f.writes.length, 1);
  assert.ok([...f.backups.values()].some(value => value.toString() === 'spreadsheet'));
  const approval = f.calls.find(call => call.params.toolName === 'authorize_workspace_file_save');
  assert.equal(approval.params.arguments.ifMatch, etag);
  assert.equal(approval.params.viewId, 'mcp-app-file');
  assert.equal((await f.resource())[1].contents[0].blob, Buffer.from('edited').toString('base64'));
});

test('source save rejects outside modifications, foreign views, revoked permissions and denied writes', async () => {
  for (const scenario of [
    'conflict',
    'view',
    'session',
    'permission',
    'owner',
    'authority',
    'denied',
    'backup',
  ]) {
    const f = fixture();
    await f.run();
    const input = {
      action: 'write',
      ifMatch: digest('spreadsheet'),
      blob: Buffer.from('edited').toString('base64'),
    };
    if (scenario === 'conflict') f.content = 'external edit';
    if (scenario === 'view') input.viewId = 'foreign-view';
    if (scenario === 'session') input.sessionId = 'new-incarnation';
    if (scenario === 'permission') f.entry.permissionMode = 'guarded';
    if (scenario === 'owner')
      globalThis.fileSdk.loadAgentHarnessMcpConfig = async () => ({
        pluginIdsByServer: { univer: 'other' },
      });
    if (scenario === 'denied') {
      const dispatch = globalThis.fileSdk.dispatchGatewayMethod;
      globalThis.fileSdk.dispatchGatewayMethod = (method, params) =>
        params.toolName === 'authorize_workspace_file_save'
          ? { ok: true, payload: { isError: true } }
          : dispatch(method, params);
    }
    if (scenario === 'backup') {
      const root = globalThis.fileSdk.root;
      globalThis.fileSdk.root = directory =>
        directory === resolve('state')
          ? {
              write: async () => {
                throw new Error('disk full');
              },
            }
          : root(directory);
    }
    const response = await f.resource(input, () => scenario !== 'authority');
    if (scenario === 'conflict') assert.deepEqual(response, [true, { outcome: 'conflict' }]);
    else assert.equal(response[0], false, scenario);
    assert.equal(f.writes.length, 0, scenario);
  }
});

test('a failed or uncertain source write is never automatically retried', async () => {
  const f = fixture();
  await f.run();
  const root = globalThis.fileSdk.root;
  let attempts = 0;
  globalThis.fileSdk.root = async directory => {
    const boundary = await root(directory);
    if (directory !== resolve('state'))
      boundary.write = async () => {
        attempts++;
        throw new Error('commit result unknown');
      };
    return boundary;
  };
  assert.equal(
    (
      await f.resource({
        action: 'write',
        ifMatch: digest('spreadsheet'),
        blob: Buffer.from('edited').toString('base64'),
      })
    )[0],
    false,
  );
  assert.equal(attempts, 1);
});

test('source writes reject an external edit during atomic write preparation', async () => {
  const f = fixture();
  await f.run();
  const root = globalThis.fileSdk.root;
  globalThis.fileSdk.root = async directory => {
    const boundary = await root(directory);
    if (directory !== resolve('state')) {
      const write = boundary.write;
      boundary.write = async (...args) => {
        f.content = 'changed after last async read';
        return write(...args);
      };
    }
    return boundary;
  };
  assert.deepEqual(
    await f.resource({
      action: 'write',
      ifMatch: digest('spreadsheet'),
      blob: Buffer.from('edited').toString('base64'),
    }),
    [true, { outcome: 'conflict' }],
  );
  assert.equal(f.content.toString(), 'changed after last async read');
  assert.equal(f.writes.length, 0);
});

test('save admission is retired when tool permissions or policy changes during backup', async () => {
  for (const scenario of ['tool-overrides', 'configuration', 'plugin-denied', 'workspace-owner']) {
    const f = fixture();
    await f.run();
    const root = globalThis.fileSdk.root;
    globalThis.fileSdk.root = async directory => {
      const boundary = await root(directory);
      if (directory === resolve('state')) {
        const write = boundary.write;
        boundary.write = async (...args) => {
          await write(...args);
          if (scenario === 'tool-overrides')
            f.entry.toolOverrides = { mcpServers: { univer: false } };
          else if (scenario === 'configuration') f.config.tools = { deny: ['mcp'] };
          else if (scenario === 'plugin-denied') f.config.plugins.deny = ['univer-app'];
          else globalThis.fileSdk.getAgentWorkspaceAccess = () => ({ bridge: {} });
        };
      }
      return boundary;
    };
    assert.equal(
      (
        await f.resource({
          action: 'write',
          ifMatch: digest('spreadsheet'),
          blob: Buffer.from('edited').toString('base64'),
        })
      )[0],
      false,
      scenario,
    );
    assert.equal(f.writes.length, 0, scenario);
    assert.equal(f.content.toString(), 'spreadsheet', scenario);
  }
});
