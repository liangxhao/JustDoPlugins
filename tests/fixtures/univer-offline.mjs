import ExcelJS from 'exceljs';
import JSZip from 'jszip';

export const budgetColumns = ['项目', '数量', '单价', '金额', '完成率', '备注', '税额', '税率'];
export const budgetRows = [
  ['设备A', 2, 1250, null, 0.6, '设备采购', null, null],
  ['设备B', 3, 800, null, 0.3, '人工调试', null, null],
  ['合计', null, null, null, null, null, null, null],
];
export const budgetFormulaCells = [
  { row: 1, column: 3, formula: '=B2*C2' },
  { row: 2, column: 3, formula: '=B3*C3' },
  { row: 3, column: 3, formula: '=SUM(D2:D3)' },
  { row: 1, column: 6, formula: '=D2*$H$2' },
  { row: 1, column: 7, value: 0.13 },
];

export async function sourceWorkbookFixture() {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('原始预算');
  sheet.columns = [{ width: 22 }, { width: 14 }, { width: 18 }, { width: 22 }];
  sheet.addRows([
    ['项目', '数量', '单价', '金额'],
    ['设备A', 2, 1250, { formula: 'B2*C2', result: 2500 }],
    ['设备B', 3, 800, { formula: 'B3*C3', result: 2400 }],
    ['合计', null, null, { formula: 'SUM(D2:D3)', result: 4900 }],
  ]);
  sheet.getRow(1).height = 28;
  sheet.getRow(1).eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F766E' } };
  });
  for (const address of ['C2', 'C3', 'D2', 'D3', 'D4']) sheet.getCell(address).numFmt = '¥#,##0.00';
  sheet.views = [{ state: 'frozen', xSplit: 1, ySplit: 1 }];
  const notes = book.addWorksheet('保留说明');
  notes.getCell('A1').value = { richText: [{ text: '原始' }, { text: '说明', font: { bold: true } }] };
  notes.getCell('A2').value = new Date('2026-10-30T00:00:00.000Z');
  notes.getCell('A2').numFmt = 'yyyy-mm-dd';
  const image = book.addImage({
    base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    extension: 'png',
  });
  notes.addImage(image, { tl: { col: 1, row: 1 }, ext: { width: 30, height: 30 } });
  const zip = await JSZip.loadAsync(await book.xlsx.writeBuffer());
  zip.file('xl/customXml/offline-retained.xml', '<synthetic retained="true">Unmodified package content</synthetic>');
  return Buffer.from(await zip.generateAsync({ type: 'uint8array' }));
}
