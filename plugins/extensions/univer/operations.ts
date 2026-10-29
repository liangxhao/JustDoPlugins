import type { ICellData, IRange, IStyleData, IWorkbookData } from '@univerjs/core';
import { Direction } from '@univerjs/core';
import {
  SetRangeValuesCommand, ClearSelectionContentCommand, ClearSelectionFormatCommand, ClearSelectionAllCommand,
  AddWorksheetMergeCommand, RemoveWorksheetMergeCommand, InsertSheetCommand, SetWorksheetNameCommand,
  RemoveSheetCommand, CopySheetCommand, SetWorksheetOrderCommand, SetWorksheetHideCommand, SetWorksheetShowCommand,
  SetFrozenCommand, CancelFrozenCommand, InsertRowCommand, InsertColCommand, RemoveRowCommand, RemoveColCommand,
  SetRowHeightCommand, SetColWidthCommand, SetRowHiddenCommand, SetColHiddenCommand,
  SetSpecificRowsVisibleCommand, SetSpecificColsVisibleCommand,
} from '@univerjs/sheets';
import { SortRangeCommand } from '@univerjs/sheets-sort';
import { SetSheetFilterRangeCommand, RemoveSheetFilterCommand } from '@univerjs/sheets-filter';
import { z } from 'zod';

import { boundedQueryResult, MAX_COLUMNS, MAX_ROWS, MAX_SPREADSHEET_BYTES, validateData } from '../../../shared/contracts';
import { cellEditsSchema, editValues, readRange, readRangeSchema } from '../../../shared/spreadsheet';

const sheetId = z.string().min(1).max(128).refine(value => !['__proto__', 'constructor', 'prototype'].includes(value), 'Invalid worksheet ID.');
const sheetName = z.string().min(1).max(31).refine(value => !/[\\/?*\[\]:\x00-\x1f]/.test(value) && !value.startsWith("'") && !value.endsWith("'"), 'Invalid worksheet name.');
export const spreadsheetRangeSchema = z.object({
  startRow: z.number().int().min(0).max(MAX_ROWS),
  endRow: z.number().int().min(0).max(MAX_ROWS),
  startColumn: z.number().int().min(0).max(MAX_COLUMNS - 1),
  endColumn: z.number().int().min(0).max(MAX_COLUMNS - 1),
}).strict();
const flag = z.union([z.literal(0), z.literal(1)]);
const color = z.object({ rgb: z.string().regex(/^#[\da-f]{6}$/i) }).strict();
const decoration = z.object({ s: flag }).strict();
const border = z.object({ s: z.number().int().min(0).max(13), cl: color }).strict();
export const spreadsheetStyleSchema = z.object({
  ff: z.string().min(1).max(128).regex(/^[\p{L}\p{N} _,-]+$/u).nullable().optional(),
  fs: z.number().finite().min(1).max(200).optional(),
  bl: flag.optional(), it: flag.optional(), ul: decoration.optional(), st: decoration.optional(),
  bg: color.nullable().optional(), cl: color.nullable().optional(),
  n: z.object({ pattern: z.string().min(1).max(256) }).strict().nullable().optional(),
  ht: z.number().int().min(0).max(6).nullable().optional(),
  vt: z.number().int().min(0).max(3).nullable().optional(),
  tb: z.number().int().min(0).max(3).nullable().optional(),
  stf: flag.optional(),
  tr: z.object({ a: z.number().finite().min(-90).max(90), v: flag.optional() }).strict().nullable().optional(),
  bd: z.object({ t: border.nullable().optional(), r: border.nullable().optional(), b: border.nullable().optional(), l: border.nullable().optional() }).strict().nullable().optional(),
}).strict().refine(value => Object.keys(value).length > 0, 'Provide at least one style field.');
const rangeFields = { sheetId, range: spreadsheetRangeSchema };
const axisFields = { sheetId, start: z.number().int().min(0).max(MAX_ROWS), count: z.number().int().min(1).max(MAX_ROWS) };
export const spreadsheetOperationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('cells'), sheetId, cells: cellEditsSchema }).strict(),
  z.object({ type: z.literal('format_range'), ...rangeFields, style: spreadsheetStyleSchema }).strict(),
  z.object({ type: z.literal('clear_range'), ...rangeFields, mode: z.enum(['contents', 'formats', 'all']).default('contents') }).strict(),
  z.object({ type: z.literal('merge'), ...rangeFields, discardValues: z.boolean().default(false) }).strict(),
  z.object({ type: z.literal('unmerge'), ...rangeFields }).strict(),
  z.object({ type: z.literal('insert_rows'), ...axisFields }).strict(),
  z.object({ type: z.literal('delete_rows'), ...axisFields }).strict(),
  z.object({ type: z.literal('insert_columns'), ...axisFields }).strict(),
  z.object({ type: z.literal('delete_columns'), ...axisFields }).strict(),
  z.object({ type: z.literal('resize_rows'), ...axisFields, size: z.number().finite().min(1).max(1000) }).strict(),
  z.object({ type: z.literal('resize_columns'), ...axisFields, size: z.number().finite().min(1).max(2000) }).strict(),
  z.object({ type: z.literal('set_rows_hidden'), ...axisFields, hidden: z.boolean() }).strict(),
  z.object({ type: z.literal('set_columns_hidden'), ...axisFields, hidden: z.boolean() }).strict(),
  z.object({ type: z.literal('freeze'), sheetId, rows: z.number().int().min(0).max(MAX_ROWS), columns: z.number().int().min(0).max(MAX_COLUMNS) }).strict(),
  z.object({ type: z.literal('add_sheet'), sheetId, name: sheetName, index: z.number().int().min(0).max(19).optional(), rowCount: z.number().int().min(1).max(MAX_ROWS).default(200), columnCount: z.number().int().min(1).max(MAX_COLUMNS).default(26) }).strict(),
  z.object({ type: z.literal('rename_sheet'), sheetId, name: sheetName }).strict(),
  z.object({ type: z.literal('delete_sheet'), sheetId }).strict(),
  z.object({ type: z.literal('copy_sheet'), sheetId }).strict(),
  z.object({ type: z.literal('move_sheet'), sheetId, index: z.number().int().min(0).max(19) }).strict(),
  z.object({ type: z.literal('set_sheet_hidden'), sheetId, hidden: z.boolean() }).strict(),
  z.object({ type: z.literal('sort_range'), ...rangeFields, hasTitle: z.boolean().default(false), orderRules: z.array(z.object({ column: z.number().int().min(0).max(MAX_COLUMNS - 1), direction: z.enum(['asc', 'desc']) }).strict()).min(1).max(10) }).strict(),
  z.object({ type: z.literal('set_filter'), sheetId, range: spreadsheetRangeSchema.nullable() }).strict(),
]);
export type SpreadsheetOperation = z.infer<typeof spreadsheetOperationSchema>;
export const univerApplySchema = z.object({
  sheetId: sheetId.optional(), cells: cellEditsSchema.optional(), operation: spreadsheetOperationSchema.optional(),
}).strict().refine(value => value.operation !== undefined
  ? value.sheetId === undefined && value.cells === undefined
  : value.sheetId !== undefined && value.cells !== undefined,
  'Provide either operation or the legacy sheetId and cells.');
export const spreadsheetInspectSchema = z.object({
  kind: z.enum(['capabilities', 'range', 'sheets', 'resources']).default('sheets'),
  sheetId: sheetId.optional(), range: spreadsheetRangeSchema.optional(),
}).strict();
export type SpreadsheetInspect = z.infer<typeof spreadsheetInspectSchema>;
type Sheet = IWorkbookData['sheets'][string];
export function getOperationSheet(book: IWorkbookData, id: string): Sheet {
  if (!book.sheetOrder.includes(id) || !Object.hasOwn(book.sheets, id)) throw new Error('Worksheet not found.');
  return book.sheets[id];
}
const contains = (a: IRange, b: IRange) => a.startRow <= b.startRow && a.endRow >= b.endRow && a.startColumn <= b.startColumn && a.endColumn >= b.endColumn;
const overlaps = (a: IRange, b: IRange) => a.startRow <= b.endRow && a.endRow >= b.startRow && a.startColumn <= b.endColumn && a.endColumn >= b.startColumn;
export const isStructuralSpreadsheetOperation = (operation: SpreadsheetOperation) =>
  !['cells', 'format_range', 'clear_range'].includes(operation.type);

/** Static rules are shared by the saved-document worker and the live editor. */
export function normalizeSpreadsheetOperation(workbook: unknown, untrusted: unknown): SpreadsheetOperation {
  const book = validateData('univer', { workbook }).workbook as unknown as IWorkbookData;
  const operation = spreadsheetOperationSchema.parse(untrusted);
  if (operation.type === 'add_sheet') {
    if (Object.hasOwn(book.sheets, operation.sheetId)) throw new Error('Worksheet ID already exists.');
    if (book.sheetOrder.length >= 20) throw new Error('At most 20 worksheets are supported.');
    if (operation.index !== undefined && operation.index > book.sheetOrder.length) throw new Error('Worksheet index is out of bounds.');
  } else getOperationSheet(book, operation.sheetId);
  if (operation.type === 'add_sheet' || operation.type === 'rename_sheet') {
    if (Object.entries(book.sheets).some(([id, sheet]) => id !== operation.sheetId && sheet.name?.toLowerCase() === operation.name.toLowerCase()))
      throw new Error('Worksheet name already exists.');
  }
  const target = operation.type === 'add_sheet' ? undefined : book.sheets[operation.sheetId];
  if (operation.type === 'copy_sheet' && book.sheetOrder.length >= 20) throw new Error('At most 20 worksheets are supported.');
  if (operation.type === 'move_sheet' && operation.index >= book.sheetOrder.length) throw new Error('Worksheet index is out of bounds.');
  if (operation.type === 'delete_sheet' || (operation.type === 'set_sheet_hidden' && operation.hidden)) {
    if (book.sheetOrder.filter(id => id !== operation.sheetId && !book.sheets[id].hidden).length === 0)
      throw new Error('Keep at least one visible worksheet.');
  }
  const checkRange = (range: IRange) => {
    if (range.startRow > range.endRow || range.startColumn > range.endColumn || range.endRow >= target!.rowCount! || range.endColumn >= target!.columnCount!)
      throw new Error('Range is outside existing worksheet bounds.');
    if ((range.endRow - range.startRow + 1) * (range.endColumn - range.startColumn + 1) > 10000)
      throw new Error('Operate on at most 10000 cells at a time.');
  };
  if ('range' in operation && operation.range) checkRange(operation.range);
  if (operation.type === 'cells') for (const cell of operation.cells) {
    if (cell.row >= target!.rowCount! || cell.column >= target!.columnCount!) throw new Error('Cell edit is outside existing worksheet bounds.');
  }
  if ('start' in operation) {
    const rows = operation.type.includes('rows'), capacity = rows ? MAX_ROWS + 1 : MAX_COLUMNS;
    const size = rows ? target!.rowCount! : target!.columnCount!;
    if (operation.start >= size || (!operation.type.startsWith('insert') && operation.start + operation.count > size))
      throw new Error('Row or column range is outside worksheet bounds.');
    if (operation.type.startsWith('insert') && size + operation.count > capacity) throw new Error('Row or column insertion exceeds worksheet capacity.');
    if (operation.type.startsWith('delete') && operation.count >= size) throw new Error('Keep at least one row and column.');
  }
  if (operation.type === 'freeze' && (operation.rows >= target!.rowCount! || operation.columns >= target!.columnCount!))
    throw new Error('Freeze must leave a scrollable row and column.');
  if (operation.type === 'sort_range') {
    if (new Set(operation.orderRules.map(rule => rule.column)).size !== operation.orderRules.length ||
      operation.orderRules.some(rule => rule.column < operation.range.startColumn || rule.column > operation.range.endColumn))
      throw new Error('Sort columns must be unique and inside the range.');
  }
  if ('range' in operation && operation.range) {
    const range = operation.range;
    for (const merge of target!.mergeData ?? []) {
      if (overlaps(range, merge) && (operation.type === 'sort_range' || !contains(range, merge)))
        throw new Error('The operation crosses a merged range. Unmerge it first.');
    }
    if (operation.type === 'merge' && !operation.discardValues) {
      for (let row = range.startRow; row <= range.endRow; row++)
        for (let column = range.startColumn; column <= range.endColumn; column++) {
          if (row === range.startRow && column === range.startColumn) continue;
          const cell = target!.cellData?.[row]?.[column];
          if (cell && (cell.v != null || cell.f || cell.p || cell.si)) throw new Error('Merge would discard existing cells. Set discardValues=true to request that explicitly.');
        }
    }
  }
  // Array, OOXML shared/data-table and dynamic-array metadata cannot safely be
  // resized by this operation contract. Ordinary runtime si groups use the engine.
  for (const [id, sheet] of Object.entries(book.sheets))
    for (const [r, row] of Object.entries(sheet.cellData ?? {}))
      for (const [c, cell] of Object.entries(row ?? {}) as [string, ICellData | null][]) {
        if (!cell || !(cell.ft || cell.fd || cell.ref)) continue;
        const changesStructure = isStructuralSpreadsheetOperation(operation);
        const changesContent = id === operation.sheetId && (operation.type === 'cells'
          ? operation.cells.some(edit => edit.row === Number(r) && edit.column === Number(c))
          : operation.type === 'clear_range' && operation.mode !== 'formats' && contains(operation.range,
            { startRow: Number(r), endRow: Number(r), startColumn: Number(c), endColumn: Number(c) }));
        if (changesStructure || changesContent) throw new Error('This operation cannot change shared, array or data-table formula metadata.');
      }
  return operation;
}

export interface SpreadsheetCommandAPI {
  executeCommand(id: string, params?: object): Promise<unknown>;
  getActiveWorkbook(): { getId(): string; save(): IWorkbookData;
    getSheetBySheetId(id: string): { getRange(row: number, column: number, rows?: number, columns?: number): { getFormula(): string } } | null;
  } | null;
}

/** Expand sparse shared-formula followers only in a detached export snapshot. */
export function materializeWorkbook(api: SpreadsheetCommandAPI): IWorkbookData {
  const workbook = api.getActiveWorkbook();
  if (!workbook) throw new Error('No active workbook.');
  const snapshot = structuredClone(workbook.save());
  const encoder = new TextEncoder();
  let bytes = encoder.encode(JSON.stringify(snapshot)).byteLength;
  if (bytes > MAX_SPREADSHEET_BYTES) throw new Error('Workbook exceeds 8 MiB.');
  for (const id of snapshot.sheetOrder) {
    let facade: ReturnType<typeof workbook.getSheetBySheetId> | undefined;
    for (const [row, cells] of Object.entries(snapshot.sheets[id].cellData ?? {}))
      for (const [column, cell] of Object.entries(cells ?? {}) as [string, ICellData | null][]) {
        if (!cell?.si) continue;
        facade ??= workbook.getSheetBySheetId(id);
        const formula = cell.f || facade?.getRange(Number(row), Number(column), 1, 1).getFormula();
        if (!formula) throw new Error('Shared formula could not be resolved.');
        bytes += encoder.encode(JSON.stringify({ ...cell, f: formula, si: undefined })).byteLength
          - encoder.encode(JSON.stringify(cell)).byteLength;
        if (bytes > MAX_SPREADSHEET_BYTES) throw new Error('Expanded shared formulas exceed 8 MiB. Split the workbook before continuing.');
        cell.f = formula;
        delete cell.si;
      }
  }
  return snapshot;
}

/** Exactly one native, undoable command. No document replacement or formula regex. */
export async function executeSpreadsheetOperation(api: SpreadsheetCommandAPI, operation: SpreadsheetOperation): Promise<void> {
  const workbook = api.getActiveWorkbook();
  if (!workbook) throw new Error('No active workbook.');
  const book = workbook.save(), unitId = workbook.getId(), subUnitId = operation.sheetId;
  const common = { unitId, subUnitId };
  let id: string, params: object;
  const range = 'range' in operation ? operation.range : undefined;
  switch (operation.type) {
    case 'cells': id = SetRangeValuesCommand.id; params = { ...common,
      range: { startRow: Math.min(...operation.cells.map(cell => cell.row)), endRow: Math.max(...operation.cells.map(cell => cell.row)),
        startColumn: Math.min(...operation.cells.map(cell => cell.column)), endColumn: Math.max(...operation.cells.map(cell => cell.column)) },
      value: editValues(operation.cells) }; break;
    case 'format_range': id = SetRangeValuesCommand.id; params = { ...common, range, value: { s: operation.style } }; break;
    case 'clear_range':
      id = operation.mode === 'contents' ? ClearSelectionContentCommand.id
        : operation.mode === 'formats' ? ClearSelectionFormatCommand.id : ClearSelectionAllCommand.id;
      params = { ...common, ranges: [range] }; break;
    case 'merge': id = AddWorksheetMergeCommand.id; params = { ...common, selections: [range], defaultMerge: true }; break;
    case 'unmerge': id = RemoveWorksheetMergeCommand.id; params = { ...common, ranges: [range] }; break;
    case 'add_sheet': id = InsertSheetCommand.id; params = { unitId, index: operation.index ?? book.sheetOrder.length,
      sheet: { id: subUnitId, name: operation.name, rowCount: operation.rowCount, columnCount: operation.columnCount, cellData: {} } }; break;
    case 'rename_sheet': id = SetWorksheetNameCommand.id; params = { ...common, name: operation.name }; break;
    case 'delete_sheet': id = RemoveSheetCommand.id; params = common; break;
    case 'copy_sheet': id = CopySheetCommand.id; params = common; break;
    case 'move_sheet': id = SetWorksheetOrderCommand.id; params = { ...common, order: operation.index }; break;
    case 'set_sheet_hidden': id = operation.hidden ? SetWorksheetHideCommand.id : SetWorksheetShowCommand.id; params = common; break;
    case 'freeze': id = operation.rows || operation.columns ? SetFrozenCommand.id : CancelFrozenCommand.id;
      params = { ...common, xSplit: operation.columns, ySplit: operation.rows, startRow: operation.rows || -1, startColumn: operation.columns || -1 }; break;
    case 'sort_range': id = SortRangeCommand.id; params = { ...common, range, hasTitle: operation.hasTitle,
      orderRules: operation.orderRules.map(rule => ({ colIndex: rule.column, type: rule.direction })) }; break;
    case 'set_filter': id = operation.range ? SetSheetFilterRangeCommand.id : RemoveSheetFilterCommand.id; params = operation.range ? { ...common, range } : common; break;
    default: {
      const rows = operation.type.includes('rows');
      const sheet = book.sheets[subUnitId];
      const axisRange = rows
        ? { startRow: operation.start, endRow: operation.start + operation.count - 1, startColumn: 0, endColumn: sheet.columnCount! - 1 }
        : { startRow: 0, endRow: sheet.rowCount! - 1, startColumn: operation.start, endColumn: operation.start + operation.count - 1 };
      if (operation.type.startsWith('insert')) {
        id = rows ? InsertRowCommand.id : InsertColCommand.id;
        params = { ...common, range: axisRange, direction: rows ? Direction.UP : Direction.LEFT };
      } else if (operation.type.startsWith('delete')) {
        id = rows ? RemoveRowCommand.id : RemoveColCommand.id; params = { ...common, range: axisRange };
      } else if ('size' in operation) {
        id = rows ? SetRowHeightCommand.id : SetColWidthCommand.id;
        params = { ...common, ranges: [axisRange], value: operation.size };
      } else {
        id = 'hidden' in operation && operation.hidden ? rows ? SetRowHiddenCommand.id : SetColHiddenCommand.id
          : rows ? SetSpecificRowsVisibleCommand.id : SetSpecificColsVisibleCommand.id;
        params = { ...common, ranges: [axisRange] };
      }
    }
  }
  if (!(await api.executeCommand(id, params))) throw new Error('The spreadsheet rejected this operation.');
}

function styleOf(book: IWorkbookData, value: unknown): IStyleData {
  return (typeof value === 'string' ? book.styles?.[value] : value) as IStyleData ?? {};
}
export function inspectSpreadsheet(workbook: unknown, untrusted: unknown): Record<string, unknown> {
  const book = validateData('univer', { workbook }).workbook as unknown as IWorkbookData;
  const options = spreadsheetInspectSchema.parse(untrusted);
  if (options.kind === 'capabilities') return boundedQueryResult({ operations: z.toJSONSchema(spreadsheetOperationSchema),
    limits: { maxWorksheets: 20, maxRows: MAX_ROWS, legacyRowsWithHeader: MAX_ROWS + 1, maxColumns: MAX_COLUMNS,
      maxDocumentBytes: MAX_SPREADSHEET_BYTES, maxCellsPerOperation: 1000, maxRangeCells: 10000 },
    formulaPolicy: 'Native commands maintain references. Array/data-table/OOXML shared metadata changes are rejected.',
    sourcePolicy: 'Source files support cell contents and basic formatting only; save a copy for structural changes.' });
  if (options.kind === 'resources') return boundedQueryResult({ resources: (book.resources ?? []).map(item => ({ name: item.name,
    bytes: new TextEncoder().encode(item.data).byteLength })) });
  if (options.kind === 'sheets') return boundedQueryResult({ sheets: book.sheetOrder.map(id => ({ id, name: book.sheets[id].name,
    rowCount: book.sheets[id].rowCount, columnCount: book.sheets[id].columnCount, hidden: book.sheets[id].hidden ?? 0,
    freeze: book.sheets[id].freeze, tabColor: book.sheets[id].tabColor, mergeCount: book.sheets[id].mergeData?.length ?? 0 })) });
  if (!options.sheetId) throw new Error('Range inspection requires sheetId.');
  const sheet = getOperationSheet(book, options.sheetId);
  const range = options.range ?? { startRow: 0, endRow: Math.min(19, sheet.rowCount! - 1), startColumn: 0, endColumn: Math.min(9, sheet.columnCount! - 1) };
  if (range.startRow > range.endRow || range.startColumn > range.endColumn || range.endRow >= sheet.rowCount! || range.endColumn >= sheet.columnCount!) throw new Error('Range is outside worksheet bounds.');
  const values = readRange(book, readRangeSchema.parse({ sheetId: options.sheetId, startRow: range.startRow, startColumn: range.startColumn,
    rowCount: range.endRow - range.startRow + 1, columnCount: range.endColumn - range.startColumn + 1 }));
  const styles = values.cells.map((row, r) => row.map((_cell, c) => {
    const rowIndex = range.startRow + r, column = range.startColumn + c;
    return { ...styleOf(book, sheet.defaultStyle),
      ...styleOf(book, sheet.rowData?.[rowIndex]?.s), ...styleOf(book, sheet.columnData?.[column]?.s),
      ...styleOf(book, sheet.cellData?.[rowIndex]?.[column]?.s) };
  }));
  return boundedQueryResult({ ...values, styles, styleResolution: 'Base styles: sheet, row, column, cell. Conditional formatting and dynamic range themes are excluded.',
    mergeData: (sheet.mergeData ?? []).filter(merge => overlaps(range, merge)), freeze: sheet.freeze,
    rowData: Object.fromEntries(Object.entries(sheet.rowData ?? {}).filter(([index]) => Number(index) >= range.startRow && Number(index) <= range.endRow)),
    columnData: Object.fromEntries(Object.entries(sheet.columnData ?? {}).filter(([index]) => Number(index) >= range.startColumn && Number(index) <= range.endColumn)),
    hidden: sheet.hidden ?? 0 });
}
