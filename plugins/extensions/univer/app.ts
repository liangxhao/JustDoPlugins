import '@univerjs/preset-sheets-core/lib/index.css';

import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core';
import {
  createUniver,
  ILocalStorageService,
  type IWorkbookData,
  LifecycleStages,
  LocaleType,
} from '@univerjs/presets';
import { CalculationMode } from '@univerjs/sheets-formula';

import { createWorkbook, MAX_SPREADSHEET_BYTES, validateData } from '../../../shared/contracts';
import { MAX_FILE_BYTES } from '../../../shared/file-contracts';
import { csvDelimiter, parseCsv, toCsv } from '../../../shared/csv';
import { mountApp } from '../../../shared/ui';
import { exportXlsx, importXlsx } from './xlsx';
import { writebackXlsx } from './xlsx-writeback';
import { ViewStorage } from './view-storage';
import { offlineLocales, offlinePresets, withOfflineSheetLimits } from './offline-presets';
import { usedSheetBounds } from './text-exchange';
import { offlineFormulaFunctions } from './offline-formulas';
import { univerApplySchema, spreadsheetInspectSchema, normalizeSpreadsheetOperation, executeSpreadsheetOperation, inspectSpreadsheet, materializeWorkbook } from './operations';
import {
  readRangeSchema,
  readRange,
} from '../../../shared/spreadsheet';

async function importSpreadsheetFile(file: File) {
  if (file.name.toLowerCase().endsWith('.xlsx'))
    return { workbook: await importXlsx(new Uint8Array(await file.arrayBuffer()), file.name) };
  if (!/\.(csv|tsv|json)$/i.test(file.name))
    throw new Error('Supported formats: XLSX, CSV, TSV, JSON.');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
  if (file.name.toLowerCase().endsWith('.json')) {
    const value = JSON.parse(text.replace(/^\uFEFF/, ''));
    return { workbook: value.workbook ?? value };
  }
  const matrix = parseCsv(
    text,
    MAX_FILE_BYTES,
    /\.tsv$/i.test(file.name) ? '\t' : csvDelimiter(text),
  );
  return { workbook: createWorkbook(file.name.replace(/\.[^.]+$/, ''), [], matrix) };
}

mountApp(
  'Univer',
  async (container, changed, app, initialDocument, requestContext) => {
    const sheet = document.createElement('div');
    sheet.id = 'sheet';
    container.append(sheet);
    const { univer, univerAPI } = createUniver({
      override: [[ILocalStorageService, { useClass: ViewStorage }]],
      locale: app.getHostContext()?.locale?.startsWith('zh') ? LocaleType.ZH_CN : LocaleType.EN_US,
      locales: offlineLocales,
      // NO_CALCULATION preserves Excel's cached results in read-only file previews.
      presets: [
        withOfflineSheetLimits(UniverSheetsCorePreset({
          container: sheet,
          formula: {
            function: offlineFormulaFunctions,
            initialFormulaComputing: initialDocument?.sourceFile
              ? CalculationMode.NO_CALCULATION
              : CalculationMode.WHEN_EMPTY,
          },
        })),
        ...offlinePresets(),
      ],
    });
    let workbook: ReturnType<typeof univerAPI.createWorkbook> | undefined;
    let listener: { dispose(): void } | undefined;
    let selectionTimer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const theme = new MutationObserver(() =>
      univerAPI.toggleDarkMode(document.documentElement.dataset.theme === 'dark'),
    );
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    univerAPI.toggleDarkMode(app.getHostContext()?.theme === 'dark');
    async function snapshotWorkbook() {
      if (!workbook) throw new Error('No workbook.');
      if (!initialDocument?.sourceFile || initialDocument.sourceFile.writable)
        await univerAPI.getFormula().onCalculationResultApplied(15000);
      return materializeWorkbook(univerAPI);
    }
    return {
      async commitEdit() {
        if (workbook?.isCellEditing() && !(await workbook.endEditingAsync(true)))
          throw new Error('Finish editing this cell before saving.');
      },
      async load(document) {
        const data = document.data.workbook as IWorkbookData;
        workbook = univerAPI.createWorkbook(data);
        if (univerAPI.getCurrentLifecycleStage() < LifecycleStages.Steady) {
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
              ready.dispose();
              reject(new Error('Spreadsheet render timed out.'));
            }, 20000);
            const ready = univerAPI.addEvent(univerAPI.Event.LifeCycleChanged, ({ stage }) => {
              if (stage >= LifecycleStages.Steady) {
                clearTimeout(timeout);
                ready.dispose();
                resolve();
              }
            });
          });
        }
        workbook.setEditable(!document.sourceFile || document.sourceFile.writable === true);
        listener = univerAPI.addEvent(univerAPI.Event.CommandExecuted, command => {
          if (command.params?.unitId !== workbook?.getId()) return;
          // Formula application is awaited by snapshots. Its cached-value
          // mutation must not make an already saved user edit dirty again.
          if (command.type === 2 && !command.options?.applyFormulaCalculationResult) changed();
          clearTimeout(selectionTimer);
          selectionTimer = setTimeout(() => {
            if (!disposed) requestContext?.();
          }, 350);
        });
      },
      async snapshot() {
        return { workbook: await snapshotWorkbook() };
      },
      async describe() {
        if (!workbook || disposed) throw new Error('No active workbook.');
        const data = await snapshotWorkbook();
        const active = workbook.getActiveSheet();
        let range: ReturnType<typeof active.getRange> | null | undefined;
        let selectionPending = false;
        try { range = active.getSelection()?.getActiveRange(); }
        catch (error) {
          if (!(error instanceof Error) || !/^Range (?:is )?out of bounds\b/.test(error.message)) throw error;
          // Native structural commands update selections on a throttled path.
          // Describe a bounded primary cell until that update finishes; do not
          // replace the selection or fail an already applied document edit.
          const primary = active.getSelection()?.getCurrentCell();
          const current = data.sheets[active.getSheetId()];
          const row = Math.min(Math.max(0, primary?.actualRow ?? 0), current.rowCount! - 1);
          const column = Math.min(Math.max(0, primary?.actualColumn ?? 0), current.columnCount! - 1);
          range = active.getRange(row, column, 1, 1);
          selectionPending = true;
        }
        const rect = range?.getRange();
        const preview = readRange(
          data,
          readRangeSchema.parse({
            sheetId: active.getSheetId(),
            rowCount: 10,
            columnCount: 10,
          }),
        );
        return {
          sheets: data.sheetOrder.map(id => ({
            id,
            name: data.sheets[id].name,
            rowCount: data.sheets[id].rowCount,
            columnCount: data.sheets[id].columnCount,
          })),
          activeSheetId: active.getSheetId(),
          ...(selectionPending ? { selectionPending: true } : {}),
          preview,
          ...(rect
            ? {
                selection: {
                  range: range!.getA1Notation(),
                  ...readRange(
                    data,
                    readRangeSchema.parse({
                      sheetId: active.getSheetId(),
                      startRow: rect.startRow,
                      startColumn: rect.startColumn,
                      rowCount: Math.min(10, rect.endRow - rect.startRow + 1),
                      columnCount: Math.min(10, rect.endColumn - rect.startColumn + 1),
                    }),
                  ),
                },
              }
            : {}),
        };
      },
      async query(input) {
        return readRange(await snapshotWorkbook(), readRangeSchema.parse(input));
      },
      async inspect(input) {
        return inspectSpreadsheet(await snapshotWorkbook(), spreadsheetInspectSchema.parse(input));
      },
      async apply(input, unchanged) {
        if (!workbook || disposed) throw new Error('No active workbook.');
        if (initialDocument?.sourceFile && !initialDocument.sourceFile.writable)
          throw new Error('Read-only spreadsheet. Save a copy before editing.');
        const patch = univerApplySchema.parse(input);
        const current = await snapshotWorkbook();
        const operation = normalizeSpreadsheetOperation(current, patch.operation ?? { type: 'cells', sheetId: patch.sheetId, cells: patch.cells });
        // Saved operations and live editing use the same bounded headless
        // engine. The preview has no persistence side effects.
        const preview = await app.callServerTool({ name: 'preview_spreadsheet_edit', arguments: { data: { workbook: current }, operation } });
        if (preview.isError || !preview.structuredContent) throw new Error(preview.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') || 'Spreadsheet operation failed validation.');
        if (disposed || !unchanged()) throw new Error('CONFLICT: The editor changed before applying.');
        sheet.inert = true;
        try {
          await executeSpreadsheetOperation(univerAPI, operation);
        } finally {
          sheet.inert = false;
        }
      },
      async exportFile(format = 'xlsx') {
        const current = await snapshotWorkbook();
        if (format === 'json') return { text: JSON.stringify(validateData('univer', { workbook: current })), extension: 'json', mimeType: 'application/json' };
        if (format === 'csv' || format === 'tsv') {
          const active = workbook!.getActiveSheet().getSheetId();
          const cells = current.sheets[active].cellData ?? {};
          const { lastRow, lastColumn } = usedSheetBounds(cells);
          const matrix = Array.from({ length: lastRow + 1 }, (_, row) => Array.from({ length: lastColumn + 1 }, (_, column) => {
            const cell = cells[row]?.[column];
            return cell?.p?.body?.dataStream?.replace(/\r\n$/, '') ?? cell?.v ?? null;
          }));
          const output = format === 'csv' ? toCsv(matrix) : '\uFEFF' + matrix.map(row => row.map(value => {
            const content = String(value ?? '');
            const safe = typeof value === 'string' && /^[=+@-]/.test(content) ? `'${content}` : content;
            return `"${safe.replaceAll('"', '""')}"`;
          }).join('\t')).join('\r\n');
          if (new TextEncoder().encode(output).byteLength > MAX_FILE_BYTES) throw new Error('Export exceeds 10 MiB. Export a smaller worksheet.');
          return { text: output, extension: format, mimeType: format === 'csv' ? 'text/csv' : 'text/tab-separated-values' };
        }
        const bytes = await exportXlsx(current);
        let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return {
          blob: btoa(binary),
          extension: 'xlsx',
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        };
      },
      async serializeSource(source) {
        const current = await snapshotWorkbook();
        const data = { workbook: current };
        if (/\.xlsx$/i.test(source.name)) {
          return {
            data,
            bytes: await writebackXlsx(
              source.bytes,
              source.data.workbook as IWorkbookData,
              current,
            ),
          };
        }
        const original = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
          source.bytes,
        );
        const before = source.data.workbook as IWorkbookData;
        if (current.sheetOrder.length !== 1 || before.sheetOrder.length !== 1)
          throw new Error('CSV and TSV support one worksheet.');
        const sheet = current.sheets[current.sheetOrder[0]];
        const separator = /\.tsv$/i.test(source.name) ? '\t' : csvDelimiter(original);
        const line = original.includes('\r\n') ? '\r\n' : original.includes('\r') ? '\r' : '\n';
        const { lastRow: maxRow, lastColumn: maxColumn } = usedSheetBounds(sheet.cellData);
        const rows = Array.from({ length: maxRow + 1 }, (_, r) =>
          Array.from({ length: maxColumn + 1 }, (_, c) => {
            const cell = sheet.cellData?.[r]?.[c];
            const value = String(cell?.p?.body?.dataStream?.replace(/\r\n$/, '') ?? cell?.v ?? '');
            return `"${value.replaceAll('"', '""')}"`;
          }).join(separator),
        );
        const text =
          (original.startsWith('\uFEFF') ? '\uFEFF' : '') +
          rows.join(line) +
          (/[\r\n]$/.test(original) ? line : '');
        return { data, bytes: new TextEncoder().encode(text) };
      },
      async dispose() {
        if (disposed) return;
        disposed = true;
        clearTimeout(selectionTimer);
        theme.disconnect();
        listener?.dispose();
        univer.dispose();
      },
    };
  },
  {
    kind: 'univer',
    importFile: importSpreadsheetFile,
    applySchema: univerApplySchema,
    querySchema: readRangeSchema,
    inspectSchema: spreadsheetInspectSchema,
    accept: '.csv,.tsv,.json,.xlsx',
    spreadsheet: true,
    maxDocumentBytes: MAX_SPREADSHEET_BYTES,
    exportFormats: [
      { value: 'xlsx', zh: 'XLSX 工作簿', en: 'XLSX workbook' },
      { value: 'csv', zh: 'CSV 当前工作表', en: 'CSV current sheet' },
      { value: 'tsv', zh: 'TSV 当前工作表', en: 'TSV current sheet' },
      { value: 'json', zh: '完整工作簿 JSON', en: 'Full workbook JSON' },
    ],
  },
);
