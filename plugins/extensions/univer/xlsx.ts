import type { ICellData, IStyleData, IWorkbookData, IWorksheetData } from '@univerjs/presets';
import ExcelJS from 'exceljs';
import { validateData } from '../../../shared/contracts';
import { assertXlsxFeatureSupport } from './workbook-features';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 64 * 1024 * 1024;

/** Inspect the central directory before the ZIP parser allocates uncompressed data. */
export function validateXlsxArchive(bytes: Uint8Array) {
  if (bytes.byteLength > MAX_FILE_BYTES) throw new Error('XLSX exceeds 10 MiB.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (
      view.getUint32(i, true) === 0x06054b50 &&
      i + 22 + view.getUint16(i + 20, true) === bytes.length
    ) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('Invalid or encrypted XLSX archive.');
  const count = view.getUint16(end + 10, true);
  const entries: { start: number; compressed: number; size: number; method: number }[] = [];
  let offset = view.getUint32(end + 16, true),
    total = 0;
  if (count > 2000 || view.getUint16(end + 4, true) || view.getUint16(end + 6, true))
    throw new Error('Unsupported XLSX archive layout.');
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50)
      throw new Error('Invalid XLSX directory.');
    const nameLength = view.getUint16(offset + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    const size = view.getUint32(offset + 24, true);
    const compressed = view.getUint32(offset + 20, true),
      method = view.getUint16(offset + 10, true);
    const local = view.getUint32(offset + 42, true);
    if (
      local + 30 > bytes.length ||
      view.getUint32(local, true) !== 0x04034b50 ||
      ![0, 8].includes(method)
    )
      throw new Error('Unsupported XLSX compression.');
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    if (start + compressed > view.getUint32(end + 16, true))
      throw new Error('Invalid XLSX entry bounds.');
    entries.push({ start, compressed, size, method });
    total += size;
    if (total > MAX_UNPACKED_BYTES || size === 0xffffffff || view.getUint16(offset + 8, true) & 1)
      throw new Error('XLSX expanded content exceeds the supported limit.');
    if (/vbaProject\.bin$/i.test(name)) throw new Error('Macro workbooks are not supported.');
    offset +=
      46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  if (offset !== end || offset - view.getUint32(end + 16, true) !== view.getUint32(end + 12, true))
    throw new Error('Invalid XLSX archive bounds.');
  return entries;
}

async function checkExpandedSizes(bytes: Uint8Array) {
  // Verify actual output as well as declared ZIP sizes before ExcelJS allocates XML.
  for (const entry of validateXlsxArchive(bytes)) {
    if (entry.method === 0) {
      if (entry.compressed !== entry.size) throw new Error('Invalid XLSX entry size.');
      continue;
    }
    const reader = new Blob([bytes.slice(entry.start, entry.start + entry.compressed)])
      .stream()
      .pipeThrough(new DecompressionStream('deflate-raw'))
      .getReader();
    let expanded = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        expanded += chunk.value.byteLength;
        if (expanded > entry.size) throw new Error('XLSX entry exceeds its declared size.');
      }
    } finally {
      await reader.cancel();
    }
    if (expanded !== entry.size) throw new Error('Invalid XLSX entry size.');
  }
}

function color(value: Partial<ExcelJS.Color> | undefined): { rgb: string } | undefined {
  if (!value?.argb || !/^[0-9a-f]{8}$/i.test(value.argb)) return undefined;
  return { rgb: `#${value.argb.slice(2)}` };
}
const borderTypes: Record<string, number> = {
  thin: 1,
  hair: 2,
  dotted: 3,
  dashed: 4,
  dashDot: 5,
  dashDotDot: 6,
  double: 7,
  medium: 8,
  mediumDashed: 9,
  mediumDashDot: 10,
  mediumDashDotDot: 11,
  slantDashDot: 12,
  thick: 13,
};
function cellStyle(cell: ExcelJS.Cell): IStyleData {
  const font = cell.font ?? {},
    alignment = cell.alignment ?? {};
  const style: IStyleData = {};
  if (font.name) style.ff = font.name;
  if (font.size) style.fs = font.size;
  if (font.bold) style.bl = 1;
  if (font.italic) style.it = 1;
  if (font.underline) style.ul = { s: 1 };
  if (font.strike) style.st = { s: 1 };
  if (font.color) style.cl = color(font.color);
  if (cell.fill?.type === 'pattern' && cell.fill.pattern === 'solid')
    style.bg = color(cell.fill.fgColor);
  if (cell.numFmt) style.n = { pattern: cell.numFmt };
  if (alignment.horizontal)
    style.ht = (
      { left: 1, center: 2, right: 3, justify: 4, distributed: 6 } as Record<string, number>
    )[alignment.horizontal];
  if (alignment.vertical)
    style.vt = (
      { top: 1, middle: 2, bottom: 3, justify: 3, distributed: 3 } as Record<string, number>
    )[alignment.vertical];
  if (alignment.wrapText) style.tb = 3;
  if (alignment.shrinkToFit) style.stf = 1;
  if (typeof alignment.textRotation === 'number') style.tr = { a: alignment.textRotation };
  const bd: NonNullable<IStyleData['bd']> = {};
  for (const [source, target] of [
    ['top', 't'],
    ['right', 'r'],
    ['bottom', 'b'],
    ['left', 'l'],
  ] as const) {
    const edge = cell.border?.[source];
    if (edge?.style)
      bd[target] = { s: borderTypes[edge.style] ?? 1, cl: color(edge.color) ?? { rgb: '#a0a6b1' } };
  }
  if (Object.keys(bd).length) style.bd = bd;
  return style;
}
function cellValue(value: ExcelJS.CellValue): ICellData {
  if (value == null) return {};
  // ExcelJS normalizes both Excel date epochs to Date; Univer uses the 1900 epoch.
  if (value instanceof Date) return { v: value.getTime() / 86400000 + 25569, t: 2 };
  if (typeof value === 'string') return { v: value, t: 1 };
  if (typeof value === 'number') return { v: value, t: 2 };
  if (typeof value === 'boolean') return { v: value, t: 3 };
  if ('richText' in value) return { v: value.richText.map(part => part.text).join(''), t: 1 };
  if ('hyperlink' in value) return { v: value.text, t: 1 };
  if ('error' in value) return { v: value.error, t: 1, custom: { xlsxError: value.error } };
  return {};
}

export async function importXlsx(bytes: Uint8Array, title: string): Promise<IWorkbookData> {
  await checkExpandedSizes(bytes);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(bytes as unknown as Parameters<typeof book.xlsx.load>[0], {
    ignoreNodes: ['picture', 'drawing', 'extLst'],
  });
  if (!book.worksheets.length || book.worksheets.length > 20)
    throw new Error('XLSX supports 1–20 worksheets.');
  const sheets: Record<string, Partial<IWorksheetData>> = {},
    styles: Record<string, IStyleData> = {};
  const styleIds = new Map<string, string>();
  for (const source of book.worksheets) {
    const columnCount = Math.max(source.columnCount, source.columns?.length ?? 0);
    if (source.rowCount > 5000 || columnCount > 100)
      throw new Error('Worksheet exceeds 5000 rows or 100 columns.');
    const id = `sheet-${source.id}`;
    const cellData: Record<number, Record<number, ICellData>> = {};
    const rowData: Record<number, { h?: number; hd?: 0 | 1 }> = {},
      columnData: Record<number, { w?: number; hd?: 0 | 1 }> = {};
    source.eachRow({ includeEmpty: true }, (row, r) => {
      if (row.height || row.hidden)
        rowData[r - 1] = {
          ...(row.height ? { h: (row.height * 96) / 72 } : {}),
          ...(row.hidden ? { hd: 1 } : {}),
        };
      row.eachCell({ includeEmpty: false }, (cell, c) => {
        if (cell.isMerged && cell.master.address !== cell.address) return;
        const formula = cell.formula;
        const value = formula ? cell.result : cell.value;
        const mapped = cellValue(value);
        // Initial formula computing is disabled in the editor so imported cached
        // values remain visible, with the formula available in the formula bar.
        if (formula) mapped.f = `=${formula}`;
        const style = cellStyle(cell);
        if (Object.keys(style).length) {
          const key = JSON.stringify(style);
          let styleId = styleIds.get(key);
          if (!styleId) {
            styleId = `s${styleIds.size}`;
            styleIds.set(key, styleId);
            styles[styleId] = style;
          }
          mapped.s = styleId;
        }
        (cellData[r - 1] ??= {})[c - 1] = mapped;
      });
    });
    (source.columns ?? []).forEach((column, c) => {
      if (column.width || column.hidden)
        columnData[c] = {
          ...(column.width ? { w: column.width * 7 + 5 } : {}),
          ...(column.hidden ? { hd: 1 } : {}),
        };
    });
    const mergeData = (source.model.merges ?? []).map(range => {
      const [first, last = first] = range.split(':');
      const a = source.getCell(first),
        b = source.getCell(last);
      return {
        startRow: Number(a.row) - 1,
        endRow: Number(b.row) - 1,
        startColumn: Number(a.col) - 1,
        endColumn: Number(b.col) - 1,
      };
    });
    const frozen = source.views?.find(view => view.state === 'frozen');
    sheets[id] = {
      id,
      name: source.name,
      hidden: source.state === 'visible' ? 0 : 1,
      rowCount: Math.max(200, source.rowCount),
      columnCount: Math.max(26, columnCount),
      cellData,
      rowData,
      columnData,
      mergeData,
      ...(frozen?.state === 'frozen'
        ? {
            freeze: {
              xSplit: frozen.xSplit ?? 0,
              ySplit: frozen.ySplit ?? 0,
              startRow: frozen.ySplit ?? 0,
              startColumn: frozen.xSplit ?? 0,
            },
          }
        : {}),
    };
  }
  if (Object.values(sheets).every(sheet => sheet.hidden))
    throw new Error('Workbook has no visible worksheet.');
  return {
    id: 'workbook',
    name: title,
    appVersion: '1.1.0',
    locale: 'zhCN',
    sheetOrder: Object.keys(sheets),
    sheets,
    styles,
  } as IWorkbookData;
}

/** Export supported sheet data; unsupported Excel objects are deliberately omitted. */
export async function exportXlsx(workbook: IWorkbookData): Promise<Uint8Array> {
  validateData('univer', { workbook });
  assertXlsxFeatureSupport(workbook);
  const book = new ExcelJS.Workbook();
  const excelColor = (value: IStyleData['cl']): Partial<ExcelJS.Color> | undefined => {
    const hex = value && typeof value.rgb === 'string' ? value.rgb.replace(/^#/, '') : undefined;
    return hex && /^[0-9a-f]{6}$/i.test(hex) ? { argb: `FF${hex}` } : undefined;
  };
  for (const id of workbook.sheetOrder) {
    const source = workbook.sheets[id];
    const sheet = book.addWorksheet(source.name, { state: source.hidden ? 'hidden' : 'visible' });
    for (const [r, row] of Object.entries(source.cellData ?? {}))
      for (const [c, data] of Object.entries(row ?? {}) as [string, ICellData | null][]) {
        if (!data) continue;
        const cell = sheet.getCell(Number(r) + 1, Number(c) + 1);
        const text = data.p?.body?.dataStream?.replace(/\r\n$/, '');
        const value = text ?? data.v ?? null;
        if (data.f)
          cell.value = {
            formula: data.f.replace(/^=/, ''),
            ...(value !== null ? { result: value as string | number | boolean } : {}),
          };
        else if (data.custom?.xlsxError === value && typeof value === 'string')
          cell.value = { error: value as ExcelJS.CellErrorValue['error'] };
        else cell.value = value;
        const style = typeof data.s === 'string' ? workbook.styles?.[data.s] : data.s;
        if (!style) continue;
        cell.font = {
          name: style.ff ?? undefined,
          size: style.fs,
          bold: Boolean(style.bl),
          italic: Boolean(style.it),
          underline: Boolean(style.ul?.s),
          strike: Boolean(style.st?.s),
          color: excelColor(style.cl),
        };
        if (style.bg && excelColor(style.bg))
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: excelColor(style.bg) };
        if (style.n?.pattern) cell.numFmt = style.n.pattern;
        cell.alignment = {
          horizontal: (
            { 1: 'left', 2: 'center', 3: 'right', 4: 'justify', 6: 'distributed' } as Record<
              number,
              ExcelJS.Alignment['horizontal']
            >
          )[style.ht ?? 0],
          vertical: (
            { 1: 'top', 2: 'middle', 3: 'bottom' } as Record<number, ExcelJS.Alignment['vertical']>
          )[style.vt ?? 0],
          wrapText: style.tb === 3,
          shrinkToFit: Boolean(style.stf),
          textRotation: style.tr?.a,
        };
        for (const [target, edge] of [
          ['top', 't'],
          ['right', 'r'],
          ['bottom', 'b'],
          ['left', 'l'],
        ] as const) {
          const border = style.bd?.[edge];
          const type = Object.entries(borderTypes).find(([, number]) => number === border?.s)?.[0];
          if (border && type)
            cell.border = {
              ...cell.border,
              [target]: { style: type, color: excelColor(border.cl) },
            };
        }
      }
    for (const [r, row] of Object.entries(source.rowData ?? {})) {
      const target = sheet.getRow(Number(r) + 1);
      if (row?.h) target.height = (row.h * 72) / 96;
      if (row?.hd) target.hidden = true;
      // ExcelJS drops a hidden empty row unless a null cell anchors its model.
      if ((row?.h || row?.hd) && !target.cellCount) target.getCell(1).value = null;
    }
    for (const [c, column] of Object.entries(source.columnData ?? {})) {
      if (column?.w) sheet.getColumn(Number(c) + 1).width = Math.max(1, (column.w - 5) / 7);
      if (column?.hd) sheet.getColumn(Number(c) + 1).hidden = true;
    }
    for (const range of source.mergeData ?? [])
      sheet.mergeCells(
        range.startRow + 1,
        range.startColumn + 1,
        range.endRow + 1,
        range.endColumn + 1,
      );
    if (source.freeze)
      sheet.views = [
        { state: 'frozen', xSplit: source.freeze.xSplit, ySplit: source.freeze.ySplit },
      ];
  }
  return new Uint8Array(await book.xlsx.writeBuffer());
}
