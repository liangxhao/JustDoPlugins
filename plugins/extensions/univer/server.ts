import { z } from 'zod';

import {
  boundedQueryResult,
  createWorkbook,
  matrixSchema,
  titleSchema,
} from '../../../shared/contracts';
import { startServer } from '../../../shared/server';
import {
  cellEditsSchema,
  readRangeSchema,
} from '../../../shared/spreadsheet';
import { workspaceFileCache } from './file-cache';
import { createSpreadsheetOperationValidator } from './operation-validator';
import { normalizeSpreadsheetOperation, spreadsheetInspectSchema, spreadsheetOperationSchema } from './operations';

const files = workspaceFileCache();
const operations = createSpreadsheetOperationValidator(__dirname);

startServer(
  'univer',
  'Univer',
  () => ({ workbook: createWorkbook('Sheet', [], []) }),
  [
    ...files.tools,
    {
      name: 'preview_file',
      description:
        'Preview a user-selected workspace spreadsheet. Reads only the host-issued file resource for this view.',
      schema: z.object({
        file: z.object({
          name: z.string().min(1).max(255),
          resourceUri: z.string().startsWith('openclaw-file://').max(256),
        }),
      }),
      view: true,
      readOnly: true,
      fileExtensions: ['.xlsx', '.csv', '.tsv'],
      run: input => ({ file: input.file }),
    },
    {
      name: 'create_spreadsheet',
      description:
        'Create a real editable spreadsheet in the conversation from column headers and rows. Use for budgets, schedules, inventories and tabular work. Strings are literal; use update_cells for formulas. Data stays on this machine.',
      schema: z.object({
        title: titleSchema,
        columns: z.array(z.string().max(120)).max(100).default([]),
        rows: matrixSchema,
      }),
      view: true,
      run: (input, store, { signal }) =>
        store.create(
          String(input.title),
          {
            workbook: createWorkbook(
              String(input.title),
              input.columns as string[],
              input.rows as z.infer<typeof matrixSchema>,
            ),
          },
          signal,
        ),
    },
    {
      name: 'read_range',
      description:
        'Read a bounded range from a saved spreadsheet without returning the whole workbook. Indices are zero-based. For unsaved editor content use the AppBridge spreadsheet_snapshot tool.',
      schema: readRangeSchema.extend({ id: z.string().uuid() }),
      readOnly: true,
      run: async (input, store, { signal }) => {
        const document = store.get(String(input.id));
        const inspected = await operations.readRange(document.data, readRangeSchema.parse(
          Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'id'))), signal);
        return boundedQueryResult({
          id: document.id,
          revision: document.revision,
          ...inspected,
        });
      },
    },
    {
      name: 'edit_spreadsheet',
      description:
        'Apply one spreadsheet operation at an exact saved revision: contents, formatting, clear, merge, rows/columns, freeze, worksheets, sort or filter range. Native commands maintain formula references; save uses an atomic revision comparison. Indices are zero-based and ranges use inclusive ends.',
      schema: z.object({ id: z.string().uuid(), expectedRevision: z.number().int().positive(), operation: spreadsheetOperationSchema }),
      view: true,
      run: async (input, store, { signal }) => {
        const document = store.get(String(input.id));
        const operation = normalizeSpreadsheetOperation(document.data.workbook, input.operation);
        const result = await operations.preview(document.data, operation, signal);
        signal.throwIfAborted();
        return store.save(document.id, Number(input.expectedRevision), document.title, { workbook: result.workbook }, signal);
      },
    },
    {
      name: 'preview_spreadsheet_edit',
      description: 'Preflight one operation on an unsaved spreadsheet using the local engine. Returns validation and the normalized operation; no document is written.',
      schema: z.object({ data: z.record(z.string(), z.unknown()), operation: spreadsheetOperationSchema }),
      appOnly: true,
      readOnly: true,
      run: async (input, _store, { signal }) => {
        const result = await operations.preview(input.data as Record<string, unknown>,
          normalizeSpreadsheetOperation((input.data as { workbook?: unknown }).workbook, input.operation), signal);
        return { validated: true, operation: result.operation };
      },
    },
    {
      name: 'inspect_spreadsheet',
      description: 'Inspect saved or explicitly supplied unsaved workbook capabilities, worksheet metadata, plugin resource names/sizes, or a bounded range with resolved styles. Provide exactly one id or data; no document is written.',
      schema: spreadsheetInspectSchema.extend({ id: z.string().uuid().optional(), data: z.record(z.string(), z.unknown()).optional() }),
      readOnly: true,
      run: (input, store, { signal }) => {
        const { id, data, ...options } = input;
        if ((id === undefined) === (data === undefined)) throw new Error('Provide exactly one of id or data.');
        return operations.inspect(id === undefined ? data as Record<string, unknown> : store.get(String(id)).data,
          spreadsheetInspectSchema.parse(options), signal);
      },
    },
    {
      name: 'update_cells',
      description:
        'Update cells in an existing spreadsheet using zero-based row/column indices and an exact revision. Read the document first. A formula must start with =; cell edits preserve other workbook data.',
      schema: z.object({
        id: z.string().uuid(),
        expectedRevision: z.number().int().positive(),
        sheetId: z.string().min(1),
        cells: cellEditsSchema,
      }),
      view: true,
      run: async (input, store, { signal }) => {
        const document = store.get(String(input.id));
        const operation = normalizeSpreadsheetOperation(document.data.workbook,
          { type: 'cells', sheetId: input.sheetId, cells: input.cells });
        const result = await operations.preview(document.data, operation, signal);
        signal.throwIfAborted();
        return store.save(
          document.id,
          Number(input.expectedRevision),
          document.title,
          { workbook: result.workbook },
          signal,
        );
      },
    },
  ],
  { ...files, close: operations.close },
);
