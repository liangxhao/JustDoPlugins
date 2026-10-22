import { z } from 'zod';

import { MAX_ROWS, MAX_COLUMNS, scalar } from './contracts';

export const cellEditsSchema = z
  .array(
    z
      .object({
        row: z.number().int().min(0).max(MAX_ROWS),
        column: z
          .number()
          .int()
          .min(0)
          .max(MAX_COLUMNS - 1),
        value: scalar.optional(),
        formula: z.string().startsWith('=').max(8192).optional(),
      })
      .strict()
      .refine(
        cell => (cell.value !== undefined) !== (cell.formula !== undefined),
        'Provide either value or formula.',
      ),
  )
  .min(1)
  .max(1000)
  .refine(
    cells => new Set(cells.map(cell => `${cell.row}:${cell.column}`)).size === cells.length,
    'A cell may only be updated once per operation.',
  );

export const readRangeSchema = z
  .object({
    sheetId: z.string().min(1).max(128),
    startRow: z.number().int().min(0).max(MAX_ROWS).default(0),
    startColumn: z
      .number()
      .int()
      .min(0)
      .max(MAX_COLUMNS - 1)
      .default(0),
    rowCount: z.number().int().min(1).max(100).default(20),
    columnCount: z.number().int().min(1).max(20).default(10),
  })
  .strict();

export const spreadsheetApplySchema = z
  .object({
    sheetId: z.string().min(1).max(128),
    cells: cellEditsSchema,
  })
  .strict();

type Workbook = {
  sheetOrder: string[];
  sheets: Record<
    string,
    {
      name?: string;
      rowCount: number;
      columnCount: number;
      cellData?: Record<string, Record<string, Record<string, unknown>>>;
    }
  >;
};

export function worksheet(data: unknown, sheetId: string) {
  const workbook = data as Workbook;
  if (!workbook.sheetOrder.includes(sheetId) || !Object.hasOwn(workbook.sheets, sheetId))
    throw new Error('Worksheet not found.');
  return workbook.sheets[sheetId];
}

export function readRange(data: unknown, input: z.infer<typeof readRangeSchema>) {
  const sheet = worksheet(data, input.sheetId);
  if (input.startRow >= sheet.rowCount || input.startColumn >= sheet.columnCount)
    throw new Error('Range starts outside worksheet bounds.');
  const rows = Math.min(input.rowCount, sheet.rowCount - input.startRow);
  const columns = Math.min(input.columnCount, sheet.columnCount - input.startColumn);
  return {
    sheetId: input.sheetId,
    startRow: input.startRow,
    startColumn: input.startColumn,
    rowCount: rows,
    columnCount: columns,
    cells: Array.from({ length: rows }, (_, r) =>
      Array.from({ length: columns }, (_, c) => {
        const cell = sheet.cellData?.[input.startRow + r]?.[input.startColumn + c];
        const richText = (cell?.p as { body?: { dataStream?: string } } | undefined)?.body
          ?.dataStream;
        return {
          value: cell?.v ?? (typeof richText === 'string' ? richText.replace(/\r\n$/, '') : null),
          ...(cell?.f ? { formula: cell.f } : {}),
        };
      }),
    ),
  };
}

export function editValues(cells: z.infer<typeof cellEditsSchema>) {
  const values: Record<number, Record<number, Record<string, unknown>>> = {};
  for (const cell of cells) {
    values[cell.row] ??= {};
    values[cell.row][cell.column] =
      cell.formula !== undefined
        ? { f: cell.formula, v: null, p: null, si: null, t: null }
        : {
            v: cell.value,
            f: null,
            p: null,
            si: null,
            t: typeof cell.value === 'string' ? 1 : null,
          };
  }
  return values;
}

export function updateCells(
  data: unknown,
  sheetId: string,
  cells: z.infer<typeof cellEditsSchema>,
) {
  const sheet = worksheet(data, sheetId);
  for (const cell of cells) {
    sheet.cellData ??= {};
    sheet.cellData[cell.row] ??= {};
    const { v, f, p, si, t, ...preserved } = sheet.cellData[cell.row][cell.column] ?? {};
    sheet.cellData[cell.row][cell.column] = {
      ...preserved,
      ...(cell.formula !== undefined
        ? { f: cell.formula }
        : { v: cell.value, ...(typeof cell.value === 'string' ? { t: 1 } : {}) }),
    };
    sheet.rowCount = Math.max(sheet.rowCount, cell.row + 1);
    sheet.columnCount = Math.max(sheet.columnCount, cell.column + 1);
  }
}
