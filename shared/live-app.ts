import type { App } from '@modelcontextprotocol/ext-apps';
import { z } from 'zod';

import { type AppDocument, boundedQueryResult } from './contracts';

export interface LiveEditor {
  snapshot(): Promise<Record<string, unknown>>;
  describe(): Promise<Record<string, unknown>>;
  apply(patch: Record<string, unknown>, unchanged: () => boolean): Promise<void>;
  query?(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  inspect?(input: Record<string, unknown>): Promise<Record<string, unknown>>;
}
export interface LiveState {
  document: AppDocument;
  editor: LiveEditor;
  title: string;
  dirty: boolean;
  generation: number;
  editVersion: number;
}

/** Size-bounded, valid JSON; data previews can never expand the model context without limit. */
export function contextText(value: Record<string, unknown>) {
  const text = JSON.stringify(value, (_key, item) =>
    typeof item === 'string' && item.length > 240 ? item.slice(0, 240) + '…' : item,
  );
  if (new TextEncoder().encode(text).byteLength <= 16000) return text;
  const { preview, selection, rows, config, ...identity } = value;
  const reduced = JSON.stringify({ ...identity, previewOmitted: true });
  if (new TextEncoder().encode(reduced).byteLength <= 16000) return reduced;
  const {
    kind,
    documentId,
    title,
    revision,
    dirty,
    contentStamp,
    file,
    sourceReadOnly,
    rowCount,
    activeSheetId,
    activePanelId,
  } = value;
  return JSON.stringify({
    kind,
    documentId,
    title,
    revision,
    dirty,
    contentStamp,
    file,
    sourceReadOnly,
    rowCount,
    activeSheetId,
    activePanelId,
    previewOmitted: true,
  });
}

/** Standard App tools. The authenticated host selects the admitted AppBridge instance. */
export function registerLiveTools(
  app: App,
  options: {
    kind: 'univer' | 'perspective';
    applySchema: z.ZodObject;
    querySchema?: z.ZodObject;
    inspectSchema?: z.ZodObject;
    state(): LiveState;
    exclusive<T>(operation: () => Promise<T>): Promise<T>;
    commit(): Promise<void>;
    changed(): void;
    notice(text: string, error?: boolean): void;
  },
) {
  const prefix = options.kind === 'univer' ? 'spreadsheet' : 'analysis';
  const stamps = new Map<string, { generation: number; editVersion: number; json: string }>();
  const operations = new Set<string>();
  const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  const same = (state: LiveState) => {
    try {
      const now = options.state();
      return (
        now.generation === state.generation &&
        now.document === state.document &&
        now.editor === state.editor &&
        now.editVersion === state.editVersion
      );
    } catch {
      return false;
    }
  };
  const json = (state: LiveState, data: Record<string, unknown>) =>
    JSON.stringify({ title: state.title, data });
  const result = (value: Record<string, unknown>) => ({ content: [], structuredContent: value });
  async function snapshot() {
    await options.commit();
    const state = options.state();
    const data = await state.editor.snapshot();
    const description = await state.editor.describe();
    if (!same(state)) throw new Error('CONFLICT: The editor changed while reading. Read again.');
    const stamp = crypto.randomUUID();
    if (stamps.size >= 8) stamps.delete(stamps.keys().next().value!);
    stamps.set(stamp, {
      generation: state.generation,
      editVersion: state.editVersion,
      json: json(state, data),
    });
    const value = JSON.parse(
      contextText({
        kind: `${options.kind}.snapshot.v1`,
        documentId: state.document.id,
        title: state.title,
        revision: state.document.revision,
        dirty: state.dirty,
        contentStamp: stamp,
        ...(state.document.sourceFile
          ? {
              file: { name: state.document.sourceFile.name },
              sourceReadOnly: state.document.sourceFile.writable !== true,
            }
          : {}),
        ...description,
      }),
    ) as Record<string, unknown>;
    return { value, state };
  }
  function tool(
    name: string,
    description: string,
    schema: z.ZodObject,
    handler: (input: Record<string, unknown>) => Promise<ReturnType<typeof result>>,
    write = false,
    meta?: Record<string, unknown>,
  ) {
    app.registerTool(
      name,
      {
        description,
        inputSchema: schema,
        annotations: { ...annotations, readOnlyHint: !write },
        ...(meta ? { _meta: meta } : {}),
      },
      async input => {
        try {
          return await options.exclusive(() => handler(input));
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: error instanceof Error ? error.message : 'Editor operation failed.',
              },
            ],
          };
        }
      },
    );
  }
  tool(
    `${prefix}_snapshot`,
    'Commit active editing and read the current document identity, content stamp and bounded preview. Includes unsaved edits; does not save.',
    z.object({}).strict(),
    async () => result((await snapshot()).value),
  );
  tool(
    'prepare_context',
    'Commit active editing and wait for current document context to reach the conversation. Does not save or send a message.',
    z.object({}).strict(),
    async () => {
      if (!app.getHostCapabilities()?.updateModelContext?.text)
        throw new Error('The host does not support text context updates.');
      const { value, state } = await snapshot();
      if (!same(state))
        throw new Error(
          'CONFLICT: The editor changed before context synchronization. Prepare again.',
        );
      await app.updateModelContext({ content: [{ type: 'text', text: contextText(value) }] });
      if (!same(state))
        throw new Error(
          'CONFLICT: The editor changed during context synchronization. Prepare again.',
        );
      return result({
        prepared: true,
        documentId: value.documentId,
        contentStamp: value.contentStamp,
      });
    },
    false,
    { 'workspace/prepare-context': true },
  );
  const apply = z
    .object({
      operationId: z.string().min(1).max(128),
      documentId: z.string().min(1).max(128),
      baseContentStamp: z.string().uuid(),
      patch: options.applySchema,
    })
    .strict();
  tool(
    `${prefix}_apply`,
    'Apply one operation to this exact live document at a previously read content stamp. A stale stamp or repeated operation is rejected. Success confirms editor application only; save explicitly to persist.',
    apply,
    async raw => {
      const input = apply.parse(raw);
      await options.commit();
      const state = options.state();
      const base = stamps.get(input.baseContentStamp);
      if (input.documentId !== state.document.id || !base || base.generation !== state.generation)
        throw new Error('CONFLICT: Document or editor instance changed. Read a fresh snapshot.');
      if (operations.has(input.operationId))
        throw new Error('Repeated operation. Read the current editor; do not replay.');
      const data = await state.editor.snapshot();
      if (!same(state) || base.editVersion !== state.editVersion || base.json !== json(state, data))
        throw new Error('CONFLICT: The document has local edits. Read a fresh snapshot.');
      if (operations.size >= 128)
        throw new Error('Reopen the document before further live operations.');
      // Reserve before mutation. A failed or lost response never authorizes replay.
      operations.add(input.operationId);
      try {
        await state.editor.apply(input.patch, () => same(state));
        options.changed();
        const { value: current } = await snapshot();
        return result({ operationId: input.operationId, status: 'applied', snapshot: current });
      } catch (error) {
        options.notice(
          '修改未确认，请检查当前内容；不要重复应用 / Update unconfirmed; check the editor before continuing.',
          true,
        );
        throw error;
      }
    },
    true,
  );
  if (options.querySchema)
    tool(
      `${prefix}_query`,
      'Read a bounded window of the current editor result, including its current filtering, grouping and aggregation. Does not create or save documents.',
      options.querySchema,
      async input => {
        await options.commit();
        const state = options.state();
        if (!state.editor.query) throw new Error('Query unavailable.');
        const value = await state.editor.query(input);
        if (!same(state)) throw new Error('CONFLICT: Editor changed during query.');
        return result(
          boundedQueryResult({
            documentId: state.document.id,
            revision: state.document.revision,
            dirty: state.dirty,
            ...value,
          }),
        );
      },
    );
  if (options.inspectSchema)
    tool(
      `${prefix}_inspect`,
      'Inspect the live workspace, source data, selection or supported rendering/style contracts. Includes unsaved edits; does not save.',
      options.inspectSchema,
      async input => {
        await options.commit();
        const state = options.state();
        if (!state.editor.inspect) throw new Error('Inspection unavailable.');
        const value = await state.editor.inspect(input);
        if (!same(state)) throw new Error('CONFLICT: Editor changed during inspection.');
        return result(boundedQueryResult({ documentId: state.document.id, ...value }));
      },
    );
  return {
    clear() {
      stamps.clear();
      operations.clear();
    },
  };
}
