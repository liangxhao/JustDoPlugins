import { homedir } from 'node:os';
import { join } from 'node:path';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { serveEditor } from './assets';
import { type AppDocument, idSchema, type Kind, revisionSchema, titleSchema } from './contracts';
import { DocumentStore } from './store';
import { appIcons } from './icons';

export interface DomainTool {
  name: string;
  description: string;
  schema: z.ZodObject;
  readOnly?: boolean;
  view?: boolean;
  fileExtensions?: string[];
  appOnly?: boolean;
  run: (
    input: Record<string, unknown>,
    store: DocumentStore,
    context: { signal: AbortSignal },
  ) => unknown;
}
export async function startServer(
  kind: Kind,
  label: string,
  initialData: () => Record<string, unknown>,
  domainTools: DomainTool[],
  options?: {
    readResource?: (uri: string) => unknown;
    validateDocument?: (data: Record<string, unknown>, signal?: AbortSignal) => Promise<void>;
    close?: () => void;
  },
) {
  const assets = await serveEditor(__dirname);
  const dataDir = process.env.MCP_APP_DATA_DIR || join(homedir(), '.local-mcp-apps', kind);
  const store = new DocumentStore(
    join(dataDir, 'documents.sqlite'),
    kind,
    options?.validateDocument,
  );
  const uri = `ui://${kind}/app.html`;
  const icons = appIcons(kind);
  const metadata = (manual = false) => ({
    ui: { resourceUri: uri, ...(manual ? { visibility: ['app'] } : {}) },
    ...(manual ? { 'openai/ui': { entrypoints: [{ type: 'global' }] } } : {}),
  });
  const tools: DomainTool[] = [
    {
      name: 'open_editor',
      description: `Open ${label} and the local document library.`,
      schema: z.object({}),
      view: true,
      readOnly: true,
      run: () => ({ library: true, documents: store.list() }),
    },
    {
      name: 'new_document',
      description: `Create an empty ${label} document.`,
      schema: z.object({ title: titleSchema.default(label) }),
      view: true,
      run: (input, _store, { signal }) => store.create(String(input.title), initialData(), signal),
    },
    {
      name: 'import_document',
      description: 'Import user-selected data as one validated local document.',
      schema: z.object({ title: titleSchema, data: z.record(z.string(), z.unknown()) }),
      run: (input, _store, { signal }) => store.create(String(input.title), input.data, signal),
    },
    {
      name: 'list_documents',
      description: `List the latest 100 local ${label} documents.`,
      schema: z.object({}),
      readOnly: true,
      run: () => ({ documents: store.list() }),
    },
    {
      name: 'open_document',
      description: `Open an existing ${label} document by its exact ID.`,
      schema: z.object({ id: idSchema }),
      view: true,
      readOnly: true,
      run: input => store.get(String(input.id)),
    },
    {
      name: 'read_document',
      description: 'Read the current persisted document and revision before editing.',
      schema: z.object({ id: idSchema }),
      readOnly: true,
      run: input => store.get(String(input.id)),
    },
    {
      name: 'save_document',
      description: 'Save the editor snapshot if its revision is still current.',
      schema: z.object({
        id: idSchema,
        expectedRevision: revisionSchema,
        title: titleSchema,
        data: z.record(z.string(), z.unknown()),
      }),
      run: (input, _store, { signal }) =>
        store.save(
          String(input.id),
          Number(input.expectedRevision),
          String(input.title),
          input.data,
          signal,
        ),
    },
    ...domainTools,
  ];
  const server = new Server(
    { name: `${kind}-app`, version: '0.1.0', icons },
    {
      capabilities: { tools: {}, resources: {} },
      instructions: `${label} is a local offline MCP App. Use its creation tool for real user data; the result opens an interactive interface. Documents persist locally. Always read the latest revision before editing. Never claim lossless Excel round trips or cloud collaboration.`,
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(tool => ({
      name: tool.name,
      icons,
      title: tool.name === 'open_editor' ? label : tool.name,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.schema, { target: 'draft-7' }),
      annotations: {
        readOnlyHint: Boolean(tool.readOnly),
        destructiveHint: !tool.readOnly,
        openWorldHint: false,
      },
      ...(tool.fileExtensions
        ? {
            _meta: {
              ui: { resourceUri: uri, visibility: ['app'] },
              'openai/ui': { entrypoints: [{ type: 'file', extensions: tool.fileExtensions }] },
            },
          }
        : tool.view
          ? { _meta: metadata(tool.name === 'open_editor') }
          : tool.appOnly || tool.name === 'save_document' || tool.name === 'import_document'
            ? { _meta: { ui: { visibility: ['app'] } } }
            : {}),
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }, { signal }) => {
    const tool = tools.find(item => item.name === params.name);
    if (!tool) throw new Error('Unknown tool.');
    try {
      signal.throwIfAborted();
      let result = await tool.run(tool.schema.strict().parse(params.arguments ?? {}), store, {
        signal,
      });
      if (tool.view && result && typeof result === 'object' && 'data' in result && 'id' in result) {
        // The App reads the latest revision by ID; view leases retain references only.
        const { data: _data, ...reference } = result as AppDocument;
        result = reference;
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result as Record<string, unknown>,
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          { type: 'text', text: error instanceof Error ? error.message : 'Operation failed.' },
        ],
      };
    }
  });
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{ uri, name: label, mimeType: 'text/html;profile=mcp-app' }],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async ({ params }) => {
    const resource = options?.readResource?.(params.uri);
    if (resource)
      return resource as { contents: { uri: string; mimeType: string; blob: string }[] };
    if (params.uri !== uri) throw new Error('Unknown resource.');
    return {
      contents: [
        {
          uri,
          mimeType: 'text/html;profile=mcp-app',
          text: assets.wrapper,
          _meta: {
            ui: {
              csp: { connectDomains: [], resourceDomains: [], frameDomains: [assets.origin] },
              prefersBorder: true,
            },
          },
        },
      ],
    };
  });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    assets.close();
    options?.close?.();
    store.close();
    void server.close();
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  process.stdin.once('end', close);
  void server.connect(new StdioServerTransport());
}
