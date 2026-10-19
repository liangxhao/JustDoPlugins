import ExcelJS from 'exceljs';
import { createHash } from 'node:crypto';

export async function spreadsheetFixture(date1904 = false, large = false) {
  const book = new ExcelJS.Workbook();
  book.properties.date1904 = date1904;
  const sheet = book.addWorksheet('部门预算');
  sheet.columns = [{ width: 20 }, { width: 26 }, { width: 18 }, { width: 18 }];
  sheet.addRow(['2026 年项目预算']);
  sheet.mergeCells('A1:D1');
  sheet.getRow(1).height = 36;
  sheet.getCell('A1').font = { name: 'Arial', size: 18, bold: true, color: { argb: 'FF143452' } };
  sheet.addRow(['部门', '项目', '预算', '实际']);
  sheet.getRow(2).height = 28;
  sheet.getRow(2).eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } } };
  });
  sheet.addRow(['研发', '平台升级', 80000, 75000]);
  sheet.addRow(['市场', '客户活动', 45000, 42000]);
  sheet.addRow([
    '合计',
    '',
    { formula: 'SUM(C3:C4)', result: 125000 },
    { formula: 'SUM(D3:D4)', result: 117000 },
  ]);
  for (const key of ['C3', 'D3', 'C4', 'D4', 'C5', 'D5']) sheet.getCell(key).numFmt = '¥#,##0.00';
  sheet.getRow(7).hidden = true;
  sheet.getCell('A7').value = '内部备注';
  sheet.views = [{ state: 'frozen', xSplit: 1, ySplit: 2 }];
  const notes = book.addWorksheet('说明');
  notes.addRow(['更新日期', new Date('2026-10-18T00:00:00Z')]);
  notes.getCell('B1').numFmt = 'yyyy-mm-dd';
  notes.getCell('A2').value = {
    richText: [{ text: '预算' }, { text: '说明', font: { bold: true } }],
  };
  if (large) {
    // Real cell data with limited compression, not ZIP padding or unrelated attachments.
    for (let row = 3; row <= 1202; row++) {
      for (let column = 1; column <= 10; column++) {
        notes.getCell(row, column).value = createHash('sha256')
          .update(`${row}:${column}`)
          .digest('hex');
      }
    }
  }
  return Buffer.from(await book.xlsx.writeBuffer());
}
