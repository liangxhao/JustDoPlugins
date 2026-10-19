import '@univerjs/preset-sheets-core/lib/index.css';

import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core';
import enUS from '@univerjs/preset-sheets-core/locales/en-US';
import zhCN from '@univerjs/preset-sheets-core/locales/zh-CN';
import {
  createUniver,
  ILocalStorageService,
  type IWorkbookData,
  LifecycleStages,
  LocaleType,
} from '@univerjs/presets';
import { CalculationMode } from '@univerjs/sheets-formula';

import { createWorkbook, MAX_SPREADSHEET_BYTES } from '../../shared/contracts';
import { MAX_FILE_BYTES } from '../../shared/file-contracts';
import { csvDelimiter, parseCsv } from '../../shared/csv';
import { mountApp } from '../../shared/ui';
import { exportXlsx, importXlsx } from './xlsx';
import { writebackXlsx } from './xlsx-writeback';
import { ViewStorage } from './view-storage';

mountApp(
  'Univer',
  async (container, changed, app, initialDocument) => {
    const sheet = document.createElement('div');
    sheet.id = 'sheet';
    container.append(sheet);
    const { univer, univerAPI } = createUniver({
      override: [[ILocalStorageService, { useClass: ViewStorage }]],
      locale: app.getHostContext()?.locale?.startsWith('zh') ? LocaleType.ZH_CN : LocaleType.EN_US,
      locales: { [LocaleType.ZH_CN]: zhCN, [LocaleType.EN_US]: enUS },
      // NO_CALCULATION preserves Excel's cached results in read-only file previews.
      presets: [
        UniverSheetsCorePreset({
          container: sheet,
          formula: {
            initialFormulaComputing: initialDocument?.sourceFile
              ? CalculationMode.NO_CALCULATION
              : CalculationMode.WHEN_EMPTY,
          },
        }),
      ],
    });
    let workbook: ReturnType<typeof univerAPI.createWorkbook> | undefined;
    let listener: { dispose(): void } | undefined;
    let selectionTimer: ReturnType<typeof setTimeout> | undefined;
    const theme = new MutationObserver(() =>
      univerAPI.toggleDarkMode(document.documentElement.dataset.theme === 'dark'),
    );
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    univerAPI.toggleDarkMode(app.getHostContext()?.theme === 'dark');
    async function snapshotWorkbook() {
      if (!workbook) throw new Error('No workbook.');
      if (!initialDocument?.sourceFile || initialDocument.sourceFile.writable)
        await univerAPI.getFormula().onCalculationResultApplied(15000);
      return workbook.save();
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
            const active = workbook?.getActiveSheet();
            const range = active?.getSelection()?.getActiveRange();
            if (!range || !active) return;
            const selected = range.getRange();
            const values = active
              .getRange(
                selected.startRow,
                selected.startColumn,
                Math.min(10, selected.endRow - selected.startRow + 1),
                Math.min(10, selected.endColumn - selected.startColumn + 1),
              )
              .getValues();
            void app
              .updateModelContext({
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      app: 'Univer',
                      ...(document.sourceFile
                        ? {
                            file: { name: document.sourceFile.name },
                            readOnly: document.sourceFile.writable !== true,
                          }
                        : { documentId: document.id }),
                      sheetId: active?.getSheetId(),
                      range: range.getA1Notation(),
                      values: values.map(row =>
                        row.map(value => (typeof value === 'string' ? value.slice(0, 80) : value)),
                      ),
                    }),
                  },
                ],
              })
              .catch(() => undefined);
          }, 350);
        });
      },
      async snapshot() {
        return { workbook: await snapshotWorkbook() };
      },
      async importFile(file) {
        if (file.name.toLowerCase().endsWith('.xlsx'))
          return {
            workbook: await importXlsx(new Uint8Array(await file.arrayBuffer()), file.name),
          };
        if (!/\.(csv|tsv|json)$/i.test(file.name))
          throw new Error('Supported formats: XLSX, CSV, TSV, JSON.');
        const text = await file.text();
        if (file.name.toLowerCase().endsWith('.json')) {
          const value = JSON.parse(text);
          return { workbook: value.workbook ?? value };
        }
        const matrix = parseCsv(
          text,
          MAX_FILE_BYTES,
          /\.tsv$/i.test(file.name) ? '\t' : csvDelimiter(text),
        );
        return { workbook: createWorkbook(file.name.replace(/\.[^.]+$/, ''), [], matrix) };
      },
      async exportFile() {
        const bytes = await exportXlsx(await snapshotWorkbook());
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
        const maxRow = Math.max(-1, ...Object.keys(sheet.cellData ?? {}).map(Number));
        const maxColumn = Math.max(
          -1,
          ...Object.values(sheet.cellData ?? {}).flatMap(row => Object.keys(row ?? {}).map(Number)),
        );
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
        clearTimeout(selectionTimer);
        theme.disconnect();
        listener?.dispose();
        univer.dispose();
      },
    };
  },
  { accept: '.csv,.tsv,.json,.xlsx', spreadsheet: true, maxDocumentBytes: MAX_SPREADSHEET_BYTES },
);
