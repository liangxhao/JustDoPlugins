import type { IWorksheetData } from '@univerjs/core';

/** Bound scans by stored cells, without spreading a large sheet into call arguments. */
export function usedSheetBounds(cells: IWorksheetData['cellData'] | undefined) {
  let lastRow = -1, lastColumn = -1;
  for (const [row, values] of Object.entries(cells ?? {})) {
    lastRow = Math.max(lastRow, Number(row));
    for (const column of Object.keys(values ?? {})) lastColumn = Math.max(lastColumn, Number(column));
  }
  return { lastRow, lastColumn };
}
