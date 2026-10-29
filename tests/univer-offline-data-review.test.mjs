import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { build } from 'esbuild';
import ExcelJS from 'exceljs';

const compiled = await build({ stdin: { contents: "export { validateData } from './shared/contracts.ts'; export { importXlsx } from './plugins/extensions/univer/xlsx.ts';", resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', write: false, external: ['exceljs'] });
const evaluated = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), evaluated, evaluated.exports);
const { validateData, importXlsx } = evaluated.exports;
const fixture = () => ({ workbook: { id: 'metadata-bounds', sheetOrder: ['main'], sheets: {
  main: { name: 'Metadata', rowCount: 200, columnCount: 26, cellData: {}, rowData: {}, columnData: {} },
} } });

test('Univer rejects row and column metadata beyond worksheet bounds before it reaches XLSX allocation', () => {
  for (const [field, index] of [['rowData', '200'], ['rowData', '5000'], ['rowData', '-1'], ['rowData', '1.5'], ['columnData', '26'], ['columnData', '-1']]) {
    const data = fixture();
    data.workbook.sheets.main[field][index] = { hd: 1 };
    assert.throws(() => validateData('univer', data), /bounds|metadata|index|invalid/i,
      `${field}[${index}] must not create rows or columns outside the declared worksheet`);
  }
  const valid = fixture();
  valid.workbook.sheets.main.rowData[199] = { hd: 1 };
  valid.workbook.sheets.main.columnData[25] = { hd: 1 };
  assert.equal(validateData('univer', valid).workbook.sheets.main.rowData[199].hd, 1);
  const legacy = fixture();
  legacy.workbook.sheets.main.rowCount = 5001;
  legacy.workbook.sheets.main.rowData[5000] = { hd: 1 };
  assert.equal(validateData('univer', legacy).workbook.sheets.main.rowData[5000].hd, 1,
    'The existing 5001-row header envelope remains valid when declared explicitly');
});

test('Univer XLSX import counts metadata-only rows and columns within the same capacity', async () => {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('Metadata only');
  sheet.getCell('A1').value = 1;
  sheet.getRow(5000).height = 18;
  sheet.getRow(5000).hidden = true;
  sheet.getColumn(60).hidden = true;
  const imported = await importXlsx(new Uint8Array(await book.xlsx.writeBuffer()), 'Metadata.xlsx');
  const restored = imported.sheets[imported.sheetOrder[0]];
  assert.equal(restored.rowCount, 5000);
  assert.ok(restored.columnCount >= 60 && restored.columnCount <= 100);
  assert.equal(restored.rowData[4999].hd, 1);
  assert.equal(restored.columnData[59].hd, 1);
  assert.equal(restored.cellData[4999], undefined, 'Metadata does not add cell contents');
  validateData('univer', { workbook: imported });
  sheet.getColumn(101).hidden = true;
  await assert.rejects(importXlsx(new Uint8Array(await book.xlsx.writeBuffer()), 'Too wide.xlsx'), /100|column|capacity/i);
});
