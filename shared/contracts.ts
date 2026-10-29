import { z } from 'zod';
import { normalizeAnalysisRows, validateAnalysisConfig } from './analysis';
import {
  activeAnalysisConfig,
  normalizeAnalysisWorkspace,
} from '../plugins/extensions/perspective/workspace';

export const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
export const MAX_SPREADSHEET_BYTES = 8 * 1024 * 1024;
export const MAX_ROWS = 5000;
export const MAX_COLUMNS = 100;
export const MAX_QUERY_BYTES = 256 * 1024;
export function boundedQueryResult<T extends Record<string, unknown>>(
  value: T,
  hint = 'Request fewer rows or columns.',
): T {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_QUERY_BYTES)
    throw new Error(`Query result exceeds 256 KiB. ${hint}`);
  return value;
}
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
  if (new TextEncoder().encode(JSON.stringify(record)).byteLength > maxBytes)
    throw new Error(
      `Document exceeds ${maxBytes / 1024 / 1024} MiB. Split it into smaller documents.`,
    );
  if (kind === 'perspective') {
    const { rows, schema } = normalizeAnalysisRows(rowsSchema.parse(record.rows), record.schema);
    const workspace = record.workspace === undefined
      ? undefined
      : normalizeAnalysisWorkspace(record.workspace, rows, schema);
    const normalized = {
      rows,
      schema,
      config: workspace
        ? activeAnalysisConfig({ rows, schema, workspace })
        : validateAnalysisConfig(record.config, rows, schema),
      ...(workspace ? { workspace } : {}),
    };
    if (new TextEncoder().encode(JSON.stringify(normalized)).byteLength > maxBytes)
      throw new Error(
        `Document exceeds ${maxBytes / 1024 / 1024} MiB after normalization. Split it into smaller documents.`,
      );
    return normalized;
  }
  const workbook = z
    .object({
      id: z.string().min(1),
      sheetOrder: z.array(z.string()).min(1).max(20),
      sheets: z.record(z.string(), z.record(z.string(), z.unknown())),
    })
    .passthrough()
    .parse(record.workbook);
  if (
    new Set(workbook.sheetOrder).size !== workbook.sheetOrder.length ||
    Object.keys(workbook.sheets).length !== workbook.sheetOrder.length
  )
    throw new Error('Worksheet IDs must be unique and match sheetOrder.');
  for (const id of workbook.sheetOrder) {
    if (
      !Object.hasOwn(workbook.sheets, id) ||
      ['__proto__', 'constructor', 'prototype'].includes(id)
    )
      throw new Error('Invalid worksheet ID.');
    const sheet = workbook.sheets[id];
    if (!sheet) throw new Error('Missing worksheet.');
    z.number()
      .int()
      .min(1)
      .max(MAX_ROWS + 1)
      .parse(sheet.rowCount);
    z.number().int().min(1).max(MAX_COLUMNS).parse(sheet.columnCount);
    for (const [field, extent] of [
      ['rowData', Number(sheet.rowCount)],
      ['columnData', Number(sheet.columnCount)],
    ] as const) {
      if (sheet[field] === undefined) continue;
      const metadata = z.record(z.string(), z.record(z.string(), z.unknown())).safeParse(sheet[field]);
      if (!metadata.success)
        throw new Error(`Invalid ${field} metadata. Expected records keyed by worksheet indices.`);
      for (const index of Object.keys(sheet[field] as Record<string, unknown>)) {
        const position = Number(index);
        if (!/^(0|[1-9]\d*)$/.test(index) || !Number.isSafeInteger(position) || position >= extent)
          throw new Error(`${field} metadata index is outside worksheet bounds.`);
      }
    }
    const cellData = z
      .record(z.string(), z.record(z.string(), z.unknown()))
      .parse(sheet.cellData ?? {});
    for (const [row, cells] of Object.entries(cellData)) {
      if (!/^\d+$/.test(row) || Number(row) >= Number(sheet.rowCount))
        throw new Error('Cell row is outside worksheet bounds.');
      for (const [column, value] of Object.entries(cells)) {
        if (!/^\d+$/.test(column) || Number(column) >= Number(sheet.columnCount))
          throw new Error('Cell column is outside worksheet bounds.');
        z.object({ v: scalar.optional(), f: z.string().max(8192).nullable().optional() })
          .passthrough()
          .parse(value);
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
