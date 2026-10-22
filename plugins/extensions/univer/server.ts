import { z } from 'zod';

import { createWorkbook, matrixSchema, scalar, titleSchema } from '../../../shared/contracts';
import { startServer } from '../../../shared/server';
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
      run: (input, store) =>
        store.create(String(input.title), {
          workbook: createWorkbook(
            String(input.title),
            input.columns as string[],
            input.rows as z.infer<typeof matrixSchema>,
          ),
        }),
    },
    {
      name: 'update_cells',
      description:
        'Update cells in an existing spreadsheet using zero-based row/column indices and an exact revision. Read the document first. A formula must start with =; cell edits preserve other workbook data.',
      schema: z.object({
        id: z.string().uuid(),
        expectedRevision: z.number().int().positive(),
        sheetId: z.string().min(1),
        cells: z
          .array(
            z
              .object({
                row: z.number().int().min(0).max(4999),
                column: z.number().int().min(0).max(99),
                value: scalar.optional(),
                formula: z.string().startsWith('=').max(8192).optional(),
              })
              .refine(
                cell => (cell.value !== undefined) !== (cell.formula !== undefined),
                'Provide either value or formula.',
              ),
          )
          .min(1)
          .max(1000),
      }),
      view: true,
      run: (input, store) => {
        const document = store.get(String(input.id));
        const workbook = document.data.workbook as {
          sheets: Record<
            string,
            {
              rowCount: number;
              columnCount: number;
              cellData: Record<string, Record<string, unknown>>;
            }
          >;
        };
        const sheetId = String(input.sheetId);
        if (!Object.hasOwn(workbook.sheets, sheetId)) throw new Error('Worksheet not found.');
        const sheet = workbook.sheets[sheetId];
        if (!sheet) throw new Error('Worksheet not found.');
        for (const cell of input.cells as {
          row: number;
          column: number;
          value?: unknown;
          formula?: string;
        }[]) {
          sheet.cellData ??= {};
          sheet.cellData[cell.row] ??= {};
          const previous = sheet.cellData[cell.row][cell.column];
          const style =
            previous && typeof previous === 'object' && 's' in previous ? previous.s : undefined;
          const content = cell.formula
            ? { f: cell.formula }
            : { v: cell.value, ...(typeof cell.value === 'string' ? { t: 1 } : {}) };
          sheet.cellData[cell.row][cell.column] = {
            ...(style === undefined ? {} : { s: style }),
            ...content,
          };
          sheet.rowCount = Math.max(sheet.rowCount, cell.row + 1);
          sheet.columnCount = Math.max(sheet.columnCount, cell.column + 1);
        }
        return store.save(
          document.id,
          Number(input.expectedRevision),
          document.title,
          document.data,
        );
      },
    },
  ],
  files,
);
