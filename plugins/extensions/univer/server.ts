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
  readRange,
  updateCells,
} from '../../../shared/spreadsheet';
import { workspaceFileCache } from './file-cache';

const files = workspaceFileCache();

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
      run: (input, store) => {
        const document = store.get(String(input.id));
        return boundedQueryResult({
          id: document.id,
          revision: document.revision,
          ...readRange(
            document.data.workbook,
            readRangeSchema.parse(
              Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'id')),
            ),
          ),
        });
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
      run: (input, store, { signal }) => {
        const document = store.get(String(input.id));
        updateCells(
          document.data.workbook,
          String(input.sheetId),
          cellEditsSchema.parse(input.cells),
        );
        return store.save(
          document.id,
          Number(input.expectedRevision),
          document.title,
          document.data,
          signal,
        );
      },
    },
  ],
  files,
);
