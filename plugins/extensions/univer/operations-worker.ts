import { parentPort } from 'node:worker_threads';
import { Univer, LocaleType, LogLevel, type IWorkbookData } from '@univerjs/core';
import { FUniver } from '@univerjs/core/facade';
import { UniverSheetsPlugin } from '@univerjs/sheets';
import enUS from '@univerjs/sheets/locale/en-US';
import { UniverFormulaEnginePlugin } from '@univerjs/engine-formula';
import { CalculationMode, UniverSheetsFormulaPlugin } from '@univerjs/sheets-formula';
import { UniverSheetsNumfmtPlugin } from '@univerjs/sheets-numfmt';
import { UniverSheetsFilterPlugin } from '@univerjs/sheets-filter';
import { UniverSheetsSortPlugin } from '@univerjs/sheets-sort';
import { UniverDataValidationPlugin } from '@univerjs/data-validation';
import { UniverSheetsDataValidationPlugin } from '@univerjs/sheets-data-validation';
import { UniverSheetsConditionalFormattingPlugin } from '@univerjs/sheets-conditional-formatting';
import '@univerjs/sheets/facade';
import '@univerjs/sheets-formula/facade';

import { boundedQueryResult, validateData } from '../../../shared/contracts';
import { readRange, readRangeSchema } from '../../../shared/spreadsheet';
import { offlineFormulaFunctions } from './offline-formulas';
import {
  executeSpreadsheetOperation, inspectSpreadsheet, isStructuralSpreadsheetOperation,
  materializeWorkbook, normalizeSpreadsheetOperation, spreadsheetInspectSchema,
} from './operations';

function hasContent(value: unknown): boolean {
  if (value === '' || value == null) return false;
  if (Array.isArray(value)) return value.some(hasContent);
  if (typeof value === 'object') return Object.values(value).some(hasContent);
  return true;
}
function populated(text: string) {
  try { return hasContent(JSON.parse(text)); } catch { return text.trim().length > 0; }
}

if (!parentPort) throw new Error('Spreadsheet operations require a worker.');
parentPort.on('message', async (message: { id: number; task: 'preview' | 'inspect' | 'read'; data: Record<string, unknown>; operation?: unknown; options?: unknown }) => {
  let univer: Univer | undefined;
  try {
    const data = validateData('univer', message.data);
    const original = data.workbook as unknown as IWorkbookData;
    const options = spreadsheetInspectSchema.parse(message.task === 'inspect' ? message.options ?? {} : {});
    if (message.task === 'inspect' && options.kind !== 'range') {
      parentPort!.postMessage({ id: message.id, result: inspectSpreadsheet(original, options) });
      return;
    }
    const operation = message.task === 'preview' ? normalizeSpreadsheetOperation(original, message.operation) : undefined;
    univer = new Univer({ locale: LocaleType.EN_US, locales: { enUS }, undoRedoHistoryLimit: 0, logLevel: LogLevel.SILENT });
    univer.registerPlugin(UniverSheetsPlugin, { largeSheetOperation: { largeSheetCellCountThreshold: 500101 } });
    univer.registerPlugin(UniverFormulaEnginePlugin, { function: offlineFormulaFunctions });
    univer.registerPlugin(UniverSheetsFormulaPlugin, { initialFormulaComputing: CalculationMode.NO_CALCULATION });
    univer.registerPlugin(UniverSheetsNumfmtPlugin);
    univer.registerPlugin(UniverSheetsFilterPlugin);
    univer.registerPlugin(UniverSheetsSortPlugin);
    univer.registerPlugin(UniverDataValidationPlugin);
    univer.registerPlugin(UniverSheetsDataValidationPlugin);
    univer.registerPlugin(UniverSheetsConditionalFormattingPlugin);
    const api = FUniver.newAPI(univer);
    const book = api.createWorkbook(original);
    const registered = new Set((book.save().resources ?? []).map(resource => resource.name));
    const opaque = (original.resources ?? []).filter(resource => !registered.has(resource.name));
    if (operation && isStructuralSpreadsheetOperation(operation) && opaque.some(resource => populated(resource.data)))
      throw new Error('Structural operations cannot update unknown workbook resources.');
    if (operation) await executeSpreadsheetOperation(api, operation);
    await api.getFormula().onCalculationResultApplied(10000);
    const workbook = materializeWorkbook(api);
    workbook.resources = [...(workbook.resources ?? []), ...opaque];
    const checked = validateData('univer', { workbook });
    const result = operation ? { workbook: checked.workbook, operation }
      : message.task === 'read' ? boundedQueryResult(readRange(checked.workbook, readRangeSchema.parse(message.options)))
        : inspectSpreadsheet(checked.workbook, options);
    parentPort!.postMessage({ id: message.id, result });
  } catch (cause) {
    parentPort!.postMessage({ id: message.id, error: cause instanceof Error ? cause.message : String(cause) });
  } finally { univer?.dispose(); }
});
