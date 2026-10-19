import { z } from 'zod';

export const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
export const MAX_SPREADSHEET_BYTES = 8 * 1024 * 1024;
export const MAX_ROWS = 5000;
export const MAX_COLUMNS = 100;
export const scalar = z.union([z.string().max(32768), z.number().finite(), z.boolean(), z.null()]);
export const titleSchema = z.string().trim().min(1).max(120);
export const idSchema = z.string().uuid();
export const revisionSchema = z.number().int().positive();
export const rowsSchema = z.array(z.record(z.string().min(1).max(120), scalar)).max(MAX_ROWS);
export const matrixSchema = z.array(z.array(scalar).max(MAX_COLUMNS)).max(MAX_ROWS);
export type Scalar = z.infer<typeof scalar>;
export type Kind = 'univer' | 'perspective';
export interface AppDocument {
  id: string;
  kind: Kind;
  title: string;
  revision: number;
  updatedAt: string;
  data: Record<string, unknown>;
  sourceFile?: { name: string; resourceUri: string; writable?: boolean; etag?: string };
}

export function validateData(kind: Kind, data: unknown): Record<string, unknown> {
  const record = z.record(z.string(), z.unknown()).parse(data);
  const maxBytes = kind === 'univer' ? MAX_SPREADSHEET_BYTES : MAX_DOCUMENT_BYTES;
  if (Buffer.byteLength(JSON.stringify(record)) > maxBytes)
    throw new Error(
      `Document exceeds ${maxBytes / 1024 / 1024} MiB. Split it into smaller documents.`,
    );
  if (kind === 'perspective') {
    const rows = rowsSchema.parse(record.rows);
    if (new Set(rows.flatMap(row => Object.keys(row))).size > MAX_COLUMNS)
      throw new Error('At most 100 columns are supported.');
    z.record(z.string(), z.unknown()).parse(record.config ?? {});
    return { rows, config: record.config ?? {} };
  }
  const workbook = z
    .object({
      id: z.string().min(1),
      sheetOrder: z.array(z.string()).min(1).max(20),
      sheets: z.record(z.string(), z.record(z.string(), z.unknown())),
    })
    .passthrough()
    .parse(record.workbook);
  for (const id of workbook.sheetOrder) {
    const sheet = workbook.sheets[id];
    if (!sheet) throw new Error('Missing worksheet.');
    z.number()
      .int()
      .min(1)
      .max(MAX_ROWS + 1)
      .parse(sheet.rowCount);
    z.number().int().min(1).max(MAX_COLUMNS).parse(sheet.columnCount);
    const cellData = z
      .record(z.string(), z.record(z.string(), z.unknown()))
      .parse(sheet.cellData ?? {});
    for (const [row, cells] of Object.entries(cellData)) {
      if (!/^\d+$/.test(row) || Number(row) >= Number(sheet.rowCount))
        throw new Error('Cell row is outside worksheet bounds.');
      for (const column of Object.keys(cells)) {
        if (!/^\d+$/.test(column) || Number(column) >= Number(sheet.columnCount))
          throw new Error('Cell column is outside worksheet bounds.');
      }
    }
  }
  return { workbook };
}

export function createWorkbook(title: string, columns: string[], rows: Scalar[][]) {
  const cellData: Record<number, Record<number, { v: Scalar; t?: number }>> = {};
  const matrix = columns.length ? [columns, ...rows] : rows;
  matrix.forEach((row, r) => {
    cellData[r] = {};
    row.forEach((v, c) => {
      // CSV / model strings stay literal. Formulas use the explicit update tool.
      cellData[r][c] = { v, ...(typeof v === 'string' ? { t: 1 } : {}) };
    });
  });
  return {
    id: 'workbook',
    name: title,
    appVersion: '1.1.0',
    locale: 'zhCN',
    sheetOrder: ['sheet1'],
    sheets: {
      sheet1: {
        id: 'sheet1',
        name: title.slice(0, 31),
        rowCount: Math.min(MAX_ROWS + 1, Math.max(200, matrix.length + 1)),
        columnCount: Math.max(26, columns.length, ...rows.map(row => row.length)),
        cellData,
      },
    },
  };
}
