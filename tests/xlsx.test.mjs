import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import ExcelJS from 'exceljs';
import { spreadsheetFixture } from './xlsx-fixture.mjs';

const output = await build({
  entryPoints: ['plugins/univer/xlsx.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['exceljs'],
  write: false,
});
const compiled = { exports: {} };
new Function('require', 'module', 'exports', output.outputFiles[0].text)(
  createRequire(import.meta.url),
  compiled,
  compiled.exports,
);
const { importXlsx, exportXlsx, validateXlsxArchive } = compiled.exports;

test('real XLSX preserves sheets, formulas, cached values, merges, styles, sizes and dates', async () => {
  for (const date1904 of [false, true]) {
    const bytes = await spreadsheetFixture(date1904);
    const data = await importXlsx(bytes, '预算.xlsx');
    const sheet = data.sheets['sheet-1'];
    assert.equal(data.sheetOrder.length, 2);
    assert.equal(sheet.name, '部门预算');
    assert.equal(sheet.cellData[4][2].f, '=SUM(C3:C4)');
    assert.equal(sheet.cellData[4][2].v, 125000);
    assert.equal(data.styles[sheet.cellData[1][0].s].bg.rgb, '#2563EB');
    assert.equal(data.styles[sheet.cellData[2][2].s].n.pattern, '¥#,##0.00');
    assert.deepEqual(sheet.mergeData, [{ startRow: 0, endRow: 0, startColumn: 0, endColumn: 3 }]);
    assert.equal(sheet.rowData[0].h, 48);
    assert.equal(sheet.columnData[0].w, 145);
    assert.equal(sheet.freeze.ySplit, 2);
    assert.equal(sheet.rowData[6].hd, 1);
    assert.equal(data.sheets['sheet-2'].cellData[0][1].v, 46313);
    assert.equal(data.sheets['sheet-2'].cellData[1][0].v, '预算说明');
    const exported = new ExcelJS.Workbook();
    await exported.xlsx.load(await exportXlsx(data));
    const restored = exported.getWorksheet('部门预算');
    assert.equal(exported.worksheets.length, 2);
    assert.equal(restored.getCell('C5').formula, 'SUM(C3:C4)');
    assert.equal(restored.getCell('C5').result, 125000);
    assert.equal(restored.getCell('C3').numFmt, '¥#,##0.00');
    assert.equal(restored.getCell('A2').fill.fgColor.argb, 'FF2563EB');
    assert.equal(restored.getCell('D1').master.address, 'A1');
    assert.equal(
      exported.getWorksheet('说明').getCell('B1').value.toISOString(),
      '2026-10-18T00:00:00.000Z',
    );
  }
});

test('rejects invalid, oversized, macro and forged ZIP sizes before parsing workbook XML', async () => {
  assert.throws(() => validateXlsxArchive(new Uint8Array(10)), /Invalid/);
  assert.throws(() => validateXlsxArchive(new Uint8Array(10 * 1024 * 1024 + 1)), /10 MiB/);
  const bytes = await spreadsheetFixture();
  const forged = Buffer.from(bytes);
  const directory = forged.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  forged.writeUInt32LE(0, directory + 24);
  await assert.rejects(importXlsx(forged, 'bad.xlsx'), /declared size/);
  forged.writeUInt32LE(65 * 1024 * 1024, directory + 24);
  assert.throws(() => validateXlsxArchive(forged), /exceeds/);
  const nameLength = forged.readUInt16LE(directory + 28);
  forged.writeUInt32LE(0, directory + 24);
  forged.fill(' ', directory + 46, directory + 46 + nameLength);
  forged.write('vbaProject.bin', directory + 46 + nameLength - 14);
  assert.throws(() => validateXlsxArchive(forged), /Macro/);
});
