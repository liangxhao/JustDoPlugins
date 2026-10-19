import { createHash, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';

import { getAgentWorkspaceAccess } from 'openclaw/plugin-sdk/agent-workspace-runtime';
import { loadAgentHarnessMcpConfig } from 'openclaw/plugin-sdk/agent-harness-runtime';
import type { OpenClawConfig, OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import { readRegularFileSync, root } from 'openclaw/plugin-sdk/file-access-runtime';
import { dispatchGatewayMethod } from 'openclaw/plugin-sdk/gateway-method-runtime';
import { getSessionEntry } from 'openclaw/plugin-sdk/session-store-runtime';

import {
  AUTHORIZE_FILE_SAVE_TOOL,
  FILE_DEEP_LINK_PREFIX,
  FILE_OPEN_METHOD_PREFIX,
  FILE_RESOURCE_METHOD_PREFIX,
  FILE_RESOURCE_PREFIX,
  MAX_FILE_BYTES,
  STAGE_FILE_TOOL,
} from '../../shared/file-contracts';

const PLUGIN_ID = 'univer-app';
const SERVER = 'univer';
const TTL = 10 * 60 * 1000;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
class SourceFileConflict extends Error {}
type Handler = Parameters<OpenClawPluginApi['registerGatewayMethod']>[1];
type Request = Parameters<Handler>[0];
type Entry = NonNullable<ReturnType<typeof getSessionEntry>>;
interface Scope {
  sessionKey: string;
  sessionId: string;
  agentId: string;
}
interface Grant {
  scope: Scope;
  entry: Entry;
  directory: string;
  relative: string;
  name: string;
  token: string;
  viewId: string;
  expires: number;
}

function scopeOf(params: Record<string, unknown>): Scope {
  const { sessionKey, sessionId, agentId } = params;
  if (
    typeof sessionKey !== 'string' ||
    sessionKey.length > 512 ||
    typeof sessionId !== 'string' ||
    !sessionId ||
    sessionId.length > 128 ||
    typeof agentId !== 'string' ||
    !/^[a-z0-9_-]{1,64}$/i.test(agentId) ||
    !sessionKey.startsWith(`agent:${agentId}:`)
  )
    throw new Error('Invalid spreadsheet session.');
  return { sessionKey, sessionId, agentId };
}

async function access(api: OpenClawPluginApi, request: Request, scope: Scope, expected?: Entry) {
  const readEntry = () =>
    getSessionEntry({
      sessionKey: scope.sessionKey,
      agentId: scope.agentId,
      readConsistency: 'latest',
    });
  const initial = expected ?? readEntry();
  if (!initial || initial.sessionId !== scope.sessionId)
    throw new Error('Spreadsheet session changed.');
  const permissionState = () => {
    const cfg = api.runtime.config.current();
    return JSON.stringify({
      server: cfg.mcp?.servers?.[SERVER],
      plugins: cfg.plugins,
      tools: cfg.tools,
      agents: cfg.agents,
    });
  };
  const initialPermissionState = permissionState();
  const initialToolOverrides = JSON.stringify(initial.toolOverrides);
  let boundDirectory: string | undefined;
  const assertCurrent = () => {
    const cfg = api.runtime.config.current(),
      entry = readEntry();
    const override = cfg.mcp?.servers?.[SERVER];
    const executable =
      override &&
      ['command', 'args', 'url', 'env', 'cwd', 'headers'].some(key => Object.hasOwn(override, key));
    if (
      request.signal?.aborted ||
      request.client?.connectionSignal?.aborted ||
      request.hasCurrentClientAuthority?.() === false ||
      (boundDirectory && getAgentWorkspaceAccess(boundDirectory)) ||
      cfg.mcp?.apps?.enabled !== true ||
      cfg.plugins?.enabled === false ||
      cfg.plugins?.entries?.[PLUGIN_ID]?.enabled === false ||
      override?.enabled === false ||
      executable ||
      entry?.sessionId !== scope.sessionId ||
      entry.lifecycleRevision !== initial.lifecycleRevision ||
      entry.spawnedCwd !== initial.spawnedCwd ||
      entry.sessionRoot !== initial.sessionRoot ||
      entry.execNode ||
      entry.repositoryWorkspaceId ||
      entry.permissionMode !== initial.permissionMode ||
      entry.sandboxMode !== initial.sandboxMode ||
      JSON.stringify(entry.toolOverrides) !== initialToolOverrides ||
      permissionState() !== initialPermissionState
    )
      throw new Error('Spreadsheet workspace access is unavailable or changed.');
  };
  const dispatch = async (method: string, input: Record<string, unknown>) => {
    assertCurrent();
    const result = await dispatchGatewayMethod(method, input);
    assertCurrent();
    if (!result.ok) throw new Error(result.error?.message || 'Spreadsheet operation failed.');
    return result.payload as Record<string, unknown>;
  };
  const identity = await dispatch('sessions.describe', {
    key: scope.sessionKey,
    agentId: scope.agentId,
  });
  if ((identity.session as { sessionId?: string } | null)?.sessionId !== scope.sessionId)
    throw new Error('Spreadsheet session is unavailable.');
  const workspace = async () => {
    const files = await dispatch('sessions.files.list', {
      sessionKey: scope.sessionKey,
      agentId: scope.agentId,
      path: '.',
    });
    if (
      typeof files.root !== 'string' ||
      !path.isAbsolute(files.root) ||
      getAgentWorkspaceAccess(files.root)
    )
      throw new Error('A local session workspace is required.');
    return files.root;
  };
  const directory = await workspace();
  boundDirectory = directory;
  const assertOwner = async () => {
    const loaded = await loadAgentHarnessMcpConfig({
      workspaceDir: directory,
      cfg: structuredClone(api.runtime.config.current()) as OpenClawConfig,
    });
    assertCurrent();
    if (loaded.pluginIdsByServer?.[SERVER] !== PLUGIN_ID)
      throw new Error('The spreadsheet MCP server must belong to the Univer extension.');
  };
  await assertOwner();
  const boundary = await root(directory, {
    maxBytes: MAX_FILE_BYTES,
    hardlinks: 'reject',
    symlinks: 'reject',
  });
  return { initial, directory, boundary, dispatch, assertCurrent, assertOwner, workspace };
}

export function registerWorkspaceFiles(api: OpenClawPluginApi) {
  const grants = new Map<string, Grant>();
  // Serialize saves across views and aliases. Unknown writes are never replayed.
  let saving: Promise<unknown> = Promise.resolve();
  const handle = (name: string, operation: (request: Request) => Promise<unknown>) =>
    api.registerGatewayMethod(
      name,
      async request => {
        try {
          request.respond(true, await operation(request));
        } catch (error) {
          request.respond(false, undefined, {
            code: 'UNAVAILABLE',
            message: error instanceof Error ? error.message : 'Spreadsheet operation failed.',
          });
        }
      },
      { scope: 'operator.admin' },
    );

  handle(`${FILE_OPEN_METHOD_PREFIX}${SERVER}`, async request => {
    const { params } = request,
      scope = scopeOf(params);
    const filePath = params.filePath;
    if (
      typeof filePath !== 'string' ||
      !filePath ||
      filePath.length > 4096 ||
      filePath.includes('\0') ||
      !['.xlsx', '.csv', '.tsv'].includes(path.extname(filePath).toLowerCase()) ||
      params.serverName !== SERVER ||
      params.toolName !== 'preview_file' ||
      params.entrypointType !== 'file'
    )
      throw new Error('Invalid spreadsheet file request.');
    const ctx = await access(api, request, scope);
    const relative = path.relative(ctx.directory, path.resolve(ctx.directory, filePath));
    if (
      !relative ||
      path.isAbsolute(relative) ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`)
    )
      throw new Error('The spreadsheet must be inside the session workspace.');
    const file = await ctx.boundary.read(relative);
    ctx.assertCurrent();
    if ((await ctx.workspace()) !== ctx.directory)
      throw new Error('Spreadsheet workspace changed.');
    const token = randomBytes(32).toString('hex');
    const launch = await ctx.dispatch('mcp.app.launch', {
      sessionKey: scope.sessionKey,
      agentId: scope.agentId,
      serverName: SERVER,
      toolName: 'open_editor',
      entrypointType: 'global',
      deepLink: `${FILE_DEEP_LINK_PREFIX}${token}`,
    });
    if (typeof launch.viewId !== 'string') throw new Error('Spreadsheet view is unavailable.');
    await ctx.assertOwner();
    const staged = await ctx.dispatch('mcp.app.callTool', {
      sessionKey: scope.sessionKey,
      agentId: scope.agentId,
      viewId: launch.viewId,
      toolName: STAGE_FILE_TOOL,
      arguments: { token, name: path.basename(filePath), blob: file.buffer.toString('base64') },
    });
    if (staged.isError) throw new Error('Could not prepare the spreadsheet.');
    if ((await ctx.workspace()) !== ctx.directory)
      throw new Error('Spreadsheet workspace changed.');
    ctx.assertCurrent();
    for (const [id, grant] of grants) if (grant.expires <= Date.now()) grants.delete(id);
    if (grants.size >= 64) grants.delete(grants.keys().next().value!);
    grants.set(launch.viewId, {
      scope,
      entry: structuredClone(ctx.initial),
      directory: ctx.directory,
      relative,
      name: path.basename(filePath),
      token,
      viewId: launch.viewId,
      expires: Date.now() + TTL,
    });
    return launch;
  });

  handle(`${FILE_RESOURCE_METHOD_PREFIX}${SERVER}`, async request => {
    const { params } = request,
      scope = scopeOf(params);
    const grant = typeof params.viewId === 'string' ? grants.get(params.viewId) : undefined;
    if (
      !grant ||
      grant.expires <= Date.now() ||
      JSON.stringify(grant.scope) !== JSON.stringify(scope)
    )
      throw new Error('Spreadsheet access expired. Close this tab and open the file again.');
    const uri = `${FILE_RESOURCE_PREFIX}${grant.token}`;
    if (
      !['describe', 'read', 'write'].includes(String(params.action)) ||
      (params.action !== 'describe' && params.uri !== uri)
    )
      throw new Error('Invalid spreadsheet resource.');
    const ctx = await access(api, request, scope, grant.entry);
    if (ctx.directory !== grant.directory) throw new Error('Spreadsheet workspace changed.');
    // Native validates requester ownership and current interaction authority.
    const view = await ctx.dispatch('mcp.app.view', {
      sessionKey: scope.sessionKey,
      agentId: scope.agentId,
      viewId: grant.viewId,
    });
    if (view.messageSupported !== true) throw new Error('Spreadsheet is no longer interactive.');
    if (params.action === 'describe') return { uri, name: grant.name, writable: true };
    if (params.action === 'read') {
      const file = await ctx.boundary.read(grant.relative);
      ctx.assertCurrent();
      return {
        contents: [
          {
            uri,
            mimeType: 'application/octet-stream',
            blob: file.buffer.toString('base64'),
            _meta: { 'openai/resource': { writable: true, etag: hash(file.buffer) } },
          },
        ],
      };
    }
    if (
      typeof params.ifMatch !== 'string' ||
      !/^[a-f0-9]{64}$/.test(params.ifMatch) ||
      typeof params.blob !== 'string' ||
      params.blob.length > Math.ceil(MAX_FILE_BYTES / 3) * 4
    )
      throw new Error('A matching file revision and file content are required.');
    const bytes = Buffer.from(params.blob, 'base64');
    if (!bytes.length || bytes.length > MAX_FILE_BYTES || bytes.toString('base64') !== params.blob)
      throw new Error('Invalid spreadsheet content (maximum 10 MiB).');
    // A read grant alone cannot write: native MCP approval covers this exact intent.
    const authorized = await ctx.dispatch('mcp.app.callTool', {
      sessionKey: scope.sessionKey,
      agentId: scope.agentId,
      viewId: grant.viewId,
      toolName: AUTHORIZE_FILE_SAVE_TOOL,
      arguments: {
        token: grant.token,
        name: grant.name,
        ifMatch: params.ifMatch,
        blob: params.blob,
      },
    });
    if (
      authorized.isError ||
      (authorized.structuredContent as { authorized?: boolean })?.authorized !== true
    )
      throw new Error('Spreadsheet save was not authorized.');
    const write = async () => {
      const assertWritable = () => {
        ctx.assertCurrent();
        if (grant.expires <= Date.now()) throw new Error('Spreadsheet access expired.');
      };
      assertWritable();
      await ctx.assertOwner();
      if ((await ctx.workspace()) !== grant.directory)
        throw new Error('Spreadsheet workspace changed.');
      const before = await ctx.boundary.read(grant.relative);
      ctx.assertCurrent();
      if (hash(before.buffer) !== params.ifMatch) return { outcome: 'conflict' };
      const state = await root(api.runtime.state.resolveStateDir());
      const backup = `plugin-data/univer/backups/${randomUUID()}/${grant.name}`;
      await state.write(backup, before.buffer, {
        mkdir: true,
        overwrite: false,
        mode: 0o600,
        assertBeforeMutation: assertWritable,
      });
      await state.write(
        `${backup}.json`,
        JSON.stringify({ file: path.join(grant.directory, grant.relative), etag: params.ifMatch }),
        { overwrite: false, mode: 0o600, assertBeforeMutation: assertWritable },
      );
      const latest = await ctx.boundary.read(grant.relative);
      if (hash(latest.buffer) !== params.ifMatch) return { outcome: 'conflict' };
      ctx.assertCurrent();
      try {
        await ctx.boundary.write(grant.relative, bytes, {
          renameIdentity: 'strict',
          assertBeforeMutation: () => {
            assertWritable();
            // Root checks ancestry and identity around this synchronous fence.
            // Recheck bytes immediately before staging/publication, not only
            // before asynchronous backup and write preparation.
            const current = readRegularFileSync({
              filePath: path.join(grant.directory, grant.relative),
              maxBytes: MAX_FILE_BYTES,
            });
            if (hash(current.buffer) !== params.ifMatch) throw new SourceFileConflict();
          },
          ...(before.stat ? { mode: before.stat.mode & 0o777 } : {}),
        });
      } catch (error) {
        if (error instanceof SourceFileConflict) return { outcome: 'conflict' };
        throw error;
      }
      return { outcome: 'saved', etag: hash(bytes) };
    };
    const pending = saving.then(write, write);
    saving = pending.catch(() => undefined);
    return pending;
  });
}
