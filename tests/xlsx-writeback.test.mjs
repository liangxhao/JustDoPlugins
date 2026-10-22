import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';

import { spreadsheetFixture } from './xlsx-fixture.mjs';

const dom = new JSDOM('');
globalThis.DOMParser = dom.window.DOMParser;
globalThis.XMLSerializer = dom.window.XMLSerializer;
const compiled = await build({
  entryPoints: [
    'plugins/extensions/univer/xlsx-writeback.ts',
    'plugins/extensions/univer/xlsx.ts',
  ],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outdir: 'test',
  external: ['exceljs', 'jszip'],
  write: false,
});
function evaluate(name) {
  const module = { exports: {} };
  new Function(
    'require',
    'module',
    'exports',
    compiled.outputFiles.find(file => file.path.endsWith(name)).text,
  )(createRequire(import.meta.url), module, module.exports);
  return module.exports;
}
const { writebackXlsx } = evaluate('xlsx-writeback.js');
const { importXlsx } = evaluate('xlsx.js');

test('source edits retain original package parts, rich text, pictures and unchanged styles', async () => {
  const fixture = await spreadsheetFixture();
  const packageFile = await JSZip.loadAsync(fixture);
  // The editor does not understand these parts: source saves must preserve them.
  packageFile.file('xl/charts/chart1.xml', '<chart><original/></chart>');
  packageFile.file('xl/media/image1.png', Buffer.from([137, 80, 78, 71, 1, 2, 3]));
  const original = await packageFile.generateAsync({ type: 'uint8array' });
  const baseline = await importXlsx(original, '预算.xlsx'),
    current = structuredClone(baseline);
  current.sheets['sheet-1'].cellData[2][2].v = 90000;
  current.sheets['sheet-1'].cellData[4][2].v = 135000;
  current.sheets['sheet-1'].cellData[8] = { 0: { v: '新增内容', t: 1 } };
  const bytes = await writebackXlsx(original, baseline, current);
  const after = await JSZip.loadAsync(bytes);
  for (const name of Object.keys(packageFile.files).filter(
    name => !name.endsWith('/') && !['xl/worksheets/sheet1.xml', 'xl/workbook.xml'].includes(name),
  ))
    assert.deepEqual(
      await after.file(name).async('uint8array'),
      await packageFile.file(name).async('uint8array'),
      name,
    );
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(bytes);
  assert.equal(book.getWorksheet('部门预算').getCell('C3').value, 90000);
  assert.equal(book.getWorksheet('部门预算').getCell('C5').formula, 'SUM(C3:C4)');
  assert.equal(book.getWorksheet('部门预算').getCell('C5').result, 135000);
  assert.equal(book.getWorksheet('部门预算').getCell('A9').value, '新增内容');
  assert.ok(book.getWorksheet('说明').getCell('A2').value.richText);
});

test('source style edits append formats without renumbering original styles', async () => {
  const original = await spreadsheetFixture(),
    baseline = await importXlsx(original, '预算.xlsx');
  const current = structuredClone(baseline);
  const cell = current.sheets['sheet-1'].cellData[2][2];
  cell.s = { ...current.styles[cell.s], bl: 1, bg: { rgb: '#FF0000' }, n: { pattern: '0.0000' } };
  const bytes = await writebackXlsx(original, baseline, current);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(bytes);
  const changed = book.getWorksheet('部门预算').getCell('C3');
  assert.equal(changed.font.bold, true);
  assert.equal(changed.fill.fgColor.argb, 'FFFF0000');
  assert.equal(changed.numFmt, '0.0000');
  assert.equal(book.getWorksheet('部门预算').getCell('A2').fill.fgColor.argb, 'FF2563EB');
  assert.equal(book.getWorksheet('部门预算').getCell('D3').numFmt, '¥#,##0.00');
});

test('unsupported structural changes fail before source bytes are replaced', async () => {
  const original = await spreadsheetFixture(),
    baseline = await importXlsx(original, '预算.xlsx');
  const inserted = structuredClone(baseline);
  inserted.sheets['sheet-1'].rowCount++;
  await assert.rejects(writebackXlsx(original, baseline, inserted), /layout changes/);
  const removed = structuredClone(baseline);
  removed.sheetOrder.pop();
  await assert.rejects(writebackXlsx(original, baseline, removed), /insertion, deletion/);
});

test('editing a date retains the original 1904 date system', async () => {
  const original = await spreadsheetFixture(true),
    baseline = await importXlsx(original, '预算.xlsx');
  const current = structuredClone(baseline);
  current.sheets['sheet-2'].cellData[0][1].v++;
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(await writebackXlsx(original, baseline, current));
  assert.equal(book.properties.date1904, true);
  assert.equal(
    book.getWorksheet('说明').getCell('B1').value.toISOString(),
    '2026-10-19T00:00:00.000Z',
  );
});

for (const date1904 of [false, true]) {
  for (const fromDate of [false, true]) {
    test(`${date1904 ? 1904 : 1900} date system preserves values when switching ${fromDate ? 'date to number' : 'number to date'} format`, async () => {
      const book = new ExcelJS.Workbook();
      book.properties.date1904 = date1904;
      const sheet = book.addWorksheet('Formats');
      sheet.getCell('A1').value = fromDate ? new Date('2026-10-18T00:00:00.000Z') : 46000;
      sheet.getCell('A1').numFmt = fromDate ? 'yyyy-mm-dd' : 'General';
      const original = new Uint8Array(await book.xlsx.writeBuffer());
      const baseline = await importXlsx(original, 'formats.xlsx');
      const current = structuredClone(baseline);
      const cell = current.sheets['sheet-1'].cellData[0][0];
      cell.s = { ...current.styles[cell.s], n: { pattern: fromDate ? 'General' : 'yyyy-mm-dd' } };
      const bytes = await writebackXlsx(original, baseline, current);
      const restored = new ExcelJS.Workbook();
      await restored.xlsx.load(bytes);
      assert.equal(restored.properties.date1904 ?? false, date1904);
      const saved = restored.getWorksheet('Formats').getCell('A1');
      if (fromDate) assert.equal(saved.value, cell.v);
      else assert.equal(saved.value.getTime(), (cell.v - 25569) * 86400000);
      const reimported = await importXlsx(bytes, 'formats.xlsx');
      assert.equal(reimported.sheets['sheet-1'].cellData[0][0].v, cell.v);
    });
  }
}

test('source format changes retain unrelated theme fonts, alignment and diagonal borders', async () => {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('Styles');
  sheet.getCell('A1').value = 'Keep original components';
  sheet.getCell('A1').font = { name: 'Calibri', size: 12, color: { theme: 4 }, scheme: 'minor' };
  sheet.getCell('A1').alignment = { indent: 2, readingOrder: 'rtl' };
  sheet.getCell('A1').border = { diagonal: { style: 'thin', up: true, color: { theme: 3 } } };
  const original = new Uint8Array(await book.xlsx.writeBuffer());
  const baseline = await importXlsx(original, 'styles.xlsx');
  const current = structuredClone(baseline);
  const cell = current.sheets['sheet-1'].cellData[0][0];
  cell.s = {
    ...current.styles[cell.s],
    bl: 1,
    bg: { rgb: '#00FF00' },
    bd: { ...current.styles[cell.s]?.bd, t: { s: 1, cl: { rgb: '#FF0000' } } },
  };
  const bytes = await writebackXlsx(original, baseline, current);
  const restored = new ExcelJS.Workbook();
  await restored.xlsx.load(bytes);
  const saved = restored.getWorksheet('Styles').getCell('A1');
  assert.equal(saved.font.bold, true);
  assert.equal(saved.font.color.theme, 4);
  assert.equal(saved.font.scheme, 'minor');
  assert.equal(saved.alignment.indent, 2);
  assert.equal(saved.alignment.readingOrder, 'rtl');
  assert.equal(saved.border.diagonal.up, true);
  assert.equal(saved.border.diagonal.color.theme, 3);
  assert.equal(saved.border.top.style, 'thin');
  assert.equal(saved.border.top.color.argb, 'FFFF0000');
  assert.equal(saved.fill.fgColor.argb, 'FF00FF00');
  const parts = await JSZip.loadAsync(bytes);
  const styles = new DOMParser().parseFromString(
    await parts.file('xl/styles.xml').async('string'),
    'application/xml',
  );
  const borders = Array.from(styles.getElementsByTagName('border'));
  const savedBorder = borders.at(-1);
  const names = Array.from(savedBorder.children, node => node.localName);
  assert.ok(
    names.indexOf('top') < names.indexOf('diagonal'),
    'OOXML border child ordering is preserved',
  );
});

test('selecting a font face replaces old theme and font-family bindings', async () => {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('Fonts');
  sheet.getCell('A1').value = 'Explicit font face';
  sheet.getCell('A1').font = {
    name: 'Calibri',
    size: 12,
    scheme: 'minor',
    family: 2,
    charset: 134,
    color: { theme: 4 },
  };
  const original = new Uint8Array(await book.xlsx.writeBuffer());
  const baseline = await importXlsx(original, 'fonts.xlsx');
  const current = structuredClone(baseline);
  const cell = current.sheets['sheet-1'].cellData[0][0];
  cell.s = { ...current.styles[cell.s], ff: 'Arial' };
  const restored = new ExcelJS.Workbook();
  await restored.xlsx.load(await writebackXlsx(original, baseline, current));
  const font = restored.getWorksheet('Fonts').getCell('A1').font;
  assert.equal(font.name, 'Arial');
  assert.equal(font.scheme, undefined);
  assert.equal(font.family, undefined);
  assert.equal(font.charset, undefined);
  assert.equal(font.size, 12);
  assert.equal(font.color.theme, 4);
});
