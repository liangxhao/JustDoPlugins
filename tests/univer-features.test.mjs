import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const bundle = await build({ stdin: { contents: `export * from './plugins/extensions/univer/workbook-features'; export * from './plugins/extensions/univer/text-exchange';`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', write: false });
const { assertXlsxFeatureSupport, workbookFeatureResources, usedSheetBounds } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

test('Univer refuses XLSX export that would silently drop active local rules', () => {
  for (const name of ['SHEET_FILTER_PLUGIN', 'SHEET_DATA_VALIDATION_PLUGIN', 'SHEET_CONDITIONAL_FORMATTING_PLUGIN']) {
    const workbook = { resources: [{ name, data: JSON.stringify({ sheet1: [{ range: { startRow: 0, endRow: 2 } }] }) }] };
    assert.throws(() => assertXlsxFeatureSupport(workbook), /workbook JSON/);
    assert.deepEqual(workbook.resources[0].data, JSON.stringify({ sheet1: [{ range: { startRow: 0, endRow: 2 } }] }), 'failed conversion must preserve the editable project');
  }
  assert.doesNotThrow(() => assertXlsxFeatureSupport({ resources: [{ name: 'SHEET_FILTER_PLUGIN', data: '{}' }, { name: 'SHEET_DATA_VALIDATION_PLUGIN', data: '{"sheet1":[]}' }] }));
  const before = { resources: [{ name: 'SHEET_CONDITIONAL_FORMATTING_PLUGIN', data: '' }] };
  const after = { resources: [{ name: 'SHEET_CONDITIONAL_FORMATTING_PLUGIN', data: '{"sheet1":[]}' }] };
  assert.doesNotThrow(() => assertXlsxFeatureSupport(before));
  assert.deepEqual(workbookFeatureResources(before), workbookFeatureResources(after), 'removing the last rule restores source-save compatibility');
});

test('Univer scans a large supported sheet without overflowing call arguments', () => {
  const cells = Object.fromEntries(Array.from({ length: 2000 }, (_, row) => [row, Object.fromEntries(Array.from({ length: 100 }, (_, column) => [column, { v: 'x' }]))]));
  assert.deepEqual(usedSheetBounds(cells), { lastRow: 1999, lastColumn: 99 });
  assert.deepEqual(usedSheetBounds({}), { lastRow: -1, lastColumn: -1 });
});
