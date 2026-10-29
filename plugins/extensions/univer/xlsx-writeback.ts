import type { ICellData, IStyleData, IWorkbookData } from '@univerjs/presets';
import JSZip from 'jszip';

import { exportXlsx, validateXlsxArchive } from './xlsx';
import { workbookFeatureResources } from './workbook-features';

const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const children = (node: Element, name: string) =>
  Array.from(node.children).filter(child => child.localName === name);
const child = (node: Element, name: string) => children(node, name)[0];
function xml(text: string): Document {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('Unsupported workbook XML.');
  const value = new DOMParser().parseFromString(text, 'application/xml');
  if (value.getElementsByTagName('parsererror').length) throw new Error('Invalid workbook XML.');
  return value;
}
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .filter(key => item[key] !== undefined)
            .map(key => [key, item[key]]),
        )
      : item,
  );
}
function style(book: IWorkbookData, cell: ICellData | null | undefined): IStyleData | undefined {
  return (typeof cell?.s === 'string' ? book.styles?.[cell.s] : cell?.s) ?? undefined;
}
function hasDateFormat(book: IWorkbookData, cell: ICellData | null | undefined): boolean {
  const pattern = style(book, cell)?.n?.pattern?.replace(/"[^"]*"|\\.|\[[^\]]*\]/g, '') ?? '';
  return /[ymdhs]/i.test(pattern);
}
const content = (cell: ICellData | null | undefined) => ({
  v: cell?.v,
  t: cell?.t,
  f: cell?.f,
  p: cell?.p,
});
function address(row: number, column: number) {
  let letters = '';
  for (let c = column + 1; c; c = Math.floor((c - 1) / 26))
    letters = String.fromCharCode(65 + ((c - 1) % 26)) + letters;
  return `${letters}${row + 1}`;
}
const serialize = (document: Document) => new XMLSerializer().serializeToString(document);

/** Patch supported cell edits into the original OOXML package, retaining untouched parts. */
export async function writebackXlsx(
  original: Uint8Array,
  baseline: IWorkbookData,
  current: IWorkbookData,
): Promise<Uint8Array> {
  validateXlsxArchive(original);
  if (stable(workbookFeatureResources(baseline)) !== stable(workbookFeatureResources(current)))
    throw new Error('Saving filter, validation or conditional-format rules to this source file is not supported. Save a local copy or export workbook JSON. / 当前规则变更请保存为本地副本或工作簿 JSON。');
  if (stable(baseline.sheetOrder) !== stable(current.sheetOrder))
    throw new Error(
      'Saving sheet insertion, deletion or reordering to the source file is not supported.',
    );
  for (const id of baseline.sheetOrder) {
    const before = baseline.sheets[id],
      after = current.sheets[id];
    if (
      !after ||
      [
        'name',
        'rowCount',
        'columnCount',
        'rowData',
        'columnData',
        'mergeData',
        'freeze',
        'hidden',
      ].some(
        key =>
          stable(before[key as keyof typeof before]) !== stable(after[key as keyof typeof after]),
      )
    )
      throw new Error('Saving row, column or layout changes to the source file is not supported.');
  }
  const source = await JSZip.loadAsync(original);
  if (Object.keys(source.files).some(name => name.startsWith('_xmlsignatures/')))
    throw new Error('Digitally signed workbooks cannot be changed here.');
  const exported = await JSZip.loadAsync(await exportXlsx(current));
  const read = async (zip: JSZip, name: string) => {
    const file = zip.file(name);
    if (!file) throw new Error(`Missing workbook part: ${name}`);
    return xml(await file.async('string'));
  };
  const book = await read(source, 'xl/workbook.xml');
  const rels = await read(source, 'xl/_rels/workbook.xml.rels');
  const sheets = Array.from(book.getElementsByTagNameNS(ns, 'sheet'));
  const date1904 = ['1', 'true'].includes(
    child(book.documentElement, 'workbookPr')?.getAttribute('date1904') ?? '',
  );
  const styles = await read(source, 'xl/styles.xml');
  const generatedStyles = await read(exported, 'xl/styles.xml');
  let styleMap: number[] | undefined;
  const mergeStyles = () => {
    if (styleMap) return styleMap;
    const target = styles.documentElement,
      generated = generatedStyles.documentElement;
    const offsets: Record<string, number> = {};
    for (const name of ['fonts', 'fills', 'borders']) {
      const a = child(target, name)!,
        b = child(generated, name)!;
      offsets[name] = a.children.length;
      for (const entry of Array.from(b.children)) a.append(styles.importNode(entry, true));
      a.setAttribute('count', String(a.children.length));
    }
    let formats = child(target, 'numFmts');
    if (!formats) {
      formats = styles.createElementNS(ns, 'numFmts');
      target.insertBefore(formats, target.firstChild);
    }
    const numbers = new Map<string, string>();
    let next =
      Math.max(
        163,
        ...Array.from(formats.children).map(item => Number(item.getAttribute('numFmtId'))),
      ) + 1;
    for (const entry of Array.from(child(generated, 'numFmts')?.children ?? [])) {
      const added = styles.importNode(entry, true) as Element;
      numbers.set(entry.getAttribute('numFmtId')!, String(next));
      added.setAttribute('numFmtId', String(next++));
      formats.append(added);
    }
    formats.setAttribute('count', String(formats.children.length));
    const xfs = child(target, 'cellXfs')!;
    styleMap = Array.from(child(generated, 'cellXfs')!.children).map(entry => {
      const index = xfs.children.length,
        added = styles.importNode(entry, true) as Element;
      for (const [attribute, group] of [
        ['fontId', 'fonts'],
        ['fillId', 'fills'],
        ['borderId', 'borders'],
      ])
        if (added.hasAttribute(attribute))
          added.setAttribute(
            attribute,
            String(Number(added.getAttribute(attribute)) + offsets[group]),
          );
      const number = numbers.get(added.getAttribute('numFmtId')!);
      if (number) added.setAttribute('numFmtId', number);
      added.setAttribute('xfId', '0');
      xfs.append(added);
      return index;
    });
    xfs.setAttribute('count', String(xfs.children.length));
    return styleMap;
  };
  const styleEdits = new Map<string, number>();
  const mergeCellStyle = (
    cell: Element,
    generatedCell: Element | undefined,
    oldStyle: ReturnType<typeof style>,
    newStyle: ReturnType<typeof style>,
  ) => {
    const supported = new Set([
      'ff',
      'fs',
      'bl',
      'it',
      'ul',
      'st',
      'cl',
      'bg',
      'n',
      'bd',
      'ht',
      'vt',
      'tb',
      'stf',
      'tr',
    ]);
    for (const key of new Set([...Object.keys(oldStyle ?? {}), ...Object.keys(newStyle ?? {})]))
      if (
        !supported.has(key) &&
        stable(oldStyle?.[key as keyof typeof oldStyle]) !==
          stable(newStyle?.[key as keyof typeof newStyle])
      )
        throw new Error('Saving this cell format to the source file is not supported.');
    const originalIndex = Number(cell.getAttribute('s') ?? 0);
    const mapped = mergeStyles()[Number(generatedCell?.getAttribute('s') ?? 0)];
    const key = stable([originalIndex, oldStyle, newStyle]);
    const previous = styleEdits.get(key);
    if (previous !== undefined) return previous;
    const root = styles.documentElement;
    const xfs = child(root, 'cellXfs')!;
    const originalXf = xfs.children[originalIndex];
    const generatedXf = xfs.children[mapped];
    if (!originalXf || !generatedXf) throw new Error('Unsupported workbook cell style.');
    const next = originalXf.cloneNode(true) as Element;
    const changed = (key: keyof IStyleData) => stable(oldStyle?.[key]) !== stable(newStyle?.[key]);
    const replaceChild = (
      target: Element,
      source: Element | undefined,
      name: string,
      order?: readonly string[],
    ) => {
      const value = source && child(source, name);
      const previous = children(target, name);
      if (value) {
        const next =
          previous[0] ??
          (order &&
            Array.from(target.children).find(
              item => order.indexOf(item.localName) > order.indexOf(name),
            ));
        target.insertBefore(styles.importNode(value, true), next || null);
      }
      for (const node of previous) node.remove();
    };
    const fontFields = {
      ff: 'name',
      fs: 'sz',
      bl: 'b',
      it: 'i',
      ul: 'u',
      st: 'strike',
      cl: 'color',
    } as const;
    if (Object.keys(fontFields).some(key => changed(key as keyof typeof fontFields))) {
      const fonts = child(root, 'fonts')!;
      const font = fonts.children[Number(originalXf.getAttribute('fontId') ?? 0)]?.cloneNode(
        true,
      ) as Element | undefined;
      const generatedFont = fonts.children[Number(generatedXf.getAttribute('fontId') ?? 0)];
      if (!font || !generatedFont) throw new Error('Unsupported workbook font.');
      for (const [key, name] of Object.entries(fontFields))
        if (changed(key as keyof typeof fontFields)) replaceChild(font, generatedFont, name);
      // An explicitly selected face must not remain bound to the old theme
      // font or carry the previous face's family/charset metadata.
      if (changed('ff'))
        for (const name of ['scheme', 'family', 'charset']) replaceChild(font, generatedFont, name);
      next.setAttribute('fontId', String(fonts.children.length));
      next.setAttribute('applyFont', '1');
      fonts.append(font);
      fonts.setAttribute('count', String(fonts.children.length));
    }
    if (changed('bg')) {
      next.setAttribute('fillId', generatedXf.getAttribute('fillId') ?? '0');
      next.setAttribute('applyFill', '1');
    }
    if (changed('n')) {
      next.setAttribute('numFmtId', generatedXf.getAttribute('numFmtId') ?? '0');
      next.setAttribute('applyNumberFormat', '1');
    }
    if (changed('bd')) {
      for (const edge of new Set([
        ...Object.keys(oldStyle?.bd ?? {}),
        ...Object.keys(newStyle?.bd ?? {}),
      ]))
        if (
          !['t', 'r', 'b', 'l'].includes(edge) &&
          stable(oldStyle?.bd?.[edge as 't']) !== stable(newStyle?.bd?.[edge as 't'])
        )
          throw new Error('Saving this border format to the source file is not supported.');
      const borders = child(root, 'borders')!;
      const border = borders.children[Number(originalXf.getAttribute('borderId') ?? 0)]?.cloneNode(
        true,
      ) as Element | undefined;
      const generatedBorder = borders.children[Number(generatedXf.getAttribute('borderId') ?? 0)];
      if (!border || !generatedBorder) throw new Error('Unsupported workbook border.');
      for (const [edge, name] of [
        ['t', 'top'],
        ['r', 'right'],
        ['b', 'bottom'],
        ['l', 'left'],
      ] as const)
        if (stable(oldStyle?.bd?.[edge]) !== stable(newStyle?.bd?.[edge]))
          replaceChild(border, generatedBorder, name, [
            'start',
            'end',
            'left',
            'right',
            'top',
            'bottom',
            'diagonal',
            'vertical',
            'horizontal',
            'extLst',
          ]);
      next.setAttribute('borderId', String(borders.children.length));
      next.setAttribute('applyBorder', '1');
      borders.append(border);
      borders.setAttribute('count', String(borders.children.length));
    }
    const alignmentFields = {
      ht: 'horizontal',
      vt: 'vertical',
      tb: 'wrapText',
      stf: 'shrinkToFit',
      tr: 'textRotation',
    } as const;
    if (Object.keys(alignmentFields).some(key => changed(key as keyof typeof alignmentFields))) {
      let alignment = child(next, 'alignment');
      if (!alignment) {
        alignment = styles.createElementNS(ns, 'alignment');
        next.insertBefore(alignment, child(next, 'protection') ?? child(next, 'extLst') ?? null);
      }
      const generatedAlignment = child(generatedXf, 'alignment');
      for (const [key, attribute] of Object.entries(alignmentFields))
        if (changed(key as keyof typeof alignmentFields)) {
          const value = generatedAlignment?.getAttribute(attribute);
          if (value != null) alignment.setAttribute(attribute, value);
          else alignment.removeAttribute(attribute);
        }
      next.setAttribute('applyAlignment', '1');
    }
    const index = xfs.children.length;
    xfs.append(next);
    xfs.setAttribute('count', String(xfs.children.length));
    styleEdits.set(key, index);
    return index;
  };
  const sharedPart = exported.file('xl/sharedStrings.xml');
  const shared = sharedPart
    ? Array.from(xml(await sharedPart.async('string')).getElementsByTagNameNS(ns, 'si'))
    : [];
  let edited = false;
  for (const [index, id] of current.sheetOrder.entries()) {
    const before = baseline.sheets[id],
      after = current.sheets[id],
      sheet = sheets[index];
    if (!sheet || sheet.getAttribute('name') !== before.name)
      throw new Error('Workbook sheet identity changed.');
    const relationship = Array.from(rels.documentElement.children).find(
      item => item.getAttribute('Id') === sheet.getAttribute('r:id'),
    );
    const target = relationship?.getAttribute('Target');
    if (!target || target.includes('..')) throw new Error('Unsupported worksheet path.');
    const part = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    const document = await read(source, part),
      generated = await read(exported, `xl/worksheets/sheet${index + 1}.xml`);
    const sheetData = child(document.documentElement, 'sheetData')!;
    const generatedData = child(generated.documentElement, 'sheetData')!;
    const cells = new Map(
      Array.from(sheetData.getElementsByTagNameNS(ns, 'c')).map(cell => [
        cell.getAttribute('r'),
        cell,
      ]),
    );
    const generatedCells = new Map(
      Array.from(generatedData.getElementsByTagNameNS(ns, 'c')).map(cell => [
        cell.getAttribute('r'),
        cell,
      ]),
    );
    const rows = new Map(
      children(sheetData, 'row').map(row => [Number(row.getAttribute('r')), row]),
    );
    let changed = false;
    for (const r of new Set([
      ...Object.keys(before.cellData ?? {}),
      ...Object.keys(after.cellData ?? {}),
    ]))
      for (const c of new Set([
        ...Object.keys(before.cellData?.[Number(r)] ?? {}),
        ...Object.keys(after.cellData?.[Number(r)] ?? {}),
      ])) {
        const oldCell = before.cellData?.[Number(r)]?.[Number(c)],
          newCell = after.cellData?.[Number(r)]?.[Number(c)];
        const valueChanged =
          stable(content(oldCell)) !== stable(content(newCell)) ||
          (date1904 &&
            typeof newCell?.v === 'number' &&
            hasDateFormat(baseline, oldCell) !== hasDateFormat(current, newCell));
        const styleChanged = stable(style(baseline, oldCell)) !== stable(style(current, newCell));
        if (!valueChanged && !styleChanged) continue;
        if (child(document.documentElement, 'sheetProtection'))
          throw new Error('Protected worksheets cannot be changed here.');
        changed = true;
        const ref = address(Number(r), Number(c)),
          generatedCell = generatedCells.get(ref);
        let cell = cells.get(ref);
        if (!cell) {
          let row = rows.get(Number(r) + 1);
          if (!row) {
            row = document.createElementNS(ns, 'row');
            row.setAttribute('r', String(Number(r) + 1));
            sheetData.insertBefore(
              row,
              children(sheetData, 'row').find(
                item => Number(item.getAttribute('r')) > Number(r) + 1,
              ) ?? null,
            );
            rows.set(Number(r) + 1, row);
          }
          cell = document.createElementNS(ns, 'c');
          cell.setAttribute('r', ref);
          const columnIndex = (item: Element) =>
            (item.getAttribute('r')!.match(/^[A-Z]+/)?.[0] ?? '')
              .split('')
              .reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
          row.insertBefore(
            cell,
            children(row, 'c').find(item => columnIndex(item) > Number(c) + 1) ??
              child(row, 'extLst') ??
              null,
          );
        }
        if (valueChanged) {
          const originalFormula = child(cell, 'f');
          if (
            oldCell?.f !== newCell?.f &&
            ['shared', 'array', 'dataTable'].includes(originalFormula?.getAttribute('t') ?? '')
          )
            throw new Error(
              'Changing shared or array formulas in the source file is not supported.',
            );
          const preservedFormula =
            oldCell?.f === newCell?.f ? child(cell, 'f')?.cloneNode(true) : undefined;
          for (const node of Array.from(cell.children))
            if (['v', 'f', 'is'].includes(node.localName)) node.remove();
          cell.removeAttribute('t');
          if (generatedCell) {
            if (generatedCell.hasAttribute('t'))
              cell.setAttribute('t', generatedCell.getAttribute('t')!);
            for (const node of Array.from(generatedCell.children))
              if (['v', 'f', 'is'].includes(node.localName))
                cell.insertBefore(
                  node.localName === 'f' && preservedFormula
                    ? preservedFormula
                    : document.importNode(node, true),
                  child(cell, 'extLst') ?? null,
                );
            if (cell.getAttribute('t') === 's') {
              const item = shared[Number(child(cell, 'v')?.textContent)];
              if (!item) throw new Error('Invalid shared string.');
              child(cell, 'v')?.remove();
              cell.setAttribute('t', 'inlineStr');
              const inline = document.createElementNS(ns, 'is');
              for (const node of Array.from(item.childNodes))
                inline.append(document.importNode(node, true));
              cell.insertBefore(inline, child(cell, 'extLst') ?? null);
            }
            const value = child(cell, 'v');
            if (
              date1904 &&
              hasDateFormat(current, newCell) &&
              value &&
              !cell.hasAttribute('t') &&
              Number.isFinite(Number(value.textContent))
            )
              value.textContent = String(Number(value.textContent) - 1462);
          }
        }
        if (styleChanged) {
          const mapped = mergeCellStyle(
            cell,
            generatedCell,
            style(baseline, oldCell),
            style(current, newCell),
          );
          cell.setAttribute('s', String(mapped));
        }
      }
    if (changed) {
      edited = true;
      const dimension = child(document.documentElement, 'dimension'),
        next = child(generated.documentElement, 'dimension');
      if (dimension && next) dimension.setAttribute('ref', next.getAttribute('ref')!);
      source.file(part, serialize(document));
    }
  }
  if (edited) {
    let calculation = child(book.documentElement, 'calcPr');
    if (!calculation) {
      calculation = book.createElementNS(ns, 'calcPr');
      book.documentElement.insertBefore(
        calculation,
        Array.from(book.documentElement.children).find(item =>
          [
            'oleSize',
            'customWorkbookViews',
            'pivotCaches',
            'smartTagPr',
            'smartTagTypes',
            'webPublishing',
            'fileRecoveryPr',
            'webPublishObjects',
            'extLst',
          ].includes(item.localName),
        ) ?? null,
      );
    }
    calculation.setAttribute('fullCalcOnLoad', '1');
    calculation.setAttribute('forceFullCalc', '1');
    source.file('xl/workbook.xml', serialize(book));
    // Changed formulas invalidate Excel's optional cached calculation order.
    if (source.file('xl/calcChain.xml')) {
      source.remove('xl/calcChain.xml');
      for (const relationship of Array.from(rels.documentElement.children))
        if (relationship.getAttribute('Type')?.endsWith('/calcChain')) relationship.remove();
      source.file('xl/_rels/workbook.xml.rels', serialize(rels));
      const types = await read(source, '[Content_Types].xml');
      for (const item of Array.from(types.documentElement.children))
        if (item.getAttribute('PartName') === '/xl/calcChain.xml') item.remove();
      source.file('[Content_Types].xml', serialize(types));
    }
  }
  if (styleMap) source.file('xl/styles.xml', serialize(styles));
  const bytes = await source.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  validateXlsxArchive(bytes);
  return bytes;
}
