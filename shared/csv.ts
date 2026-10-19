export function parseCsv(
  text: string,
  maxBytes = 2 * 1024 * 1024,
  separator = csvDelimiter(text),
): string[][] {
  if (new TextEncoder().encode(text).byteLength > maxBytes)
    throw new Error(`CSV exceeds ${maxBytes / 1024 / 1024} MiB.`);
  const rows: string[][] = [];
  let row: string[] = [],
    value = '',
    quoted = false,
    afterQuote = false;
  const source = text.replace(/^\uFEFF/, '');
  const cell = () => {
    row.push(value);
    if (row.length > 100) throw new Error('At most 100 columns are supported.');
    value = '';
    afterQuote = false;
  };
  const end = () => {
    cell();
    if (row.length > 100) throw new Error('At most 100 columns are supported.');
    rows.push(row);
    row = [];
    if (rows.length > 5001) throw new Error('At most 5000 data rows are supported.');
  };
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (c === '"' && source[i + 1] === '"') {
        value += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
        afterQuote = true;
      } else value += c;
    } else if (c === ',' || c === '\t') {
      // Delimiter is chosen once; tabs inside ordinary CSV remain literal.
      if (c === separator) cell();
      else {
        if (afterQuote) throw new Error('Unexpected characters after a quoted CSV field.');
        value += c;
      }
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && source[i + 1] === '\n') i++;
      end();
    } else if (c === '"' && value === '' && !afterQuote) quoted = true;
    else {
      if (afterQuote) throw new Error('Unexpected characters after a quoted CSV field.');
      value += c;
    }
  }
  if (quoted) throw new Error('Unclosed CSV quote.');
  if (value || row.length || afterQuote) end();
  return rows;
}
export function csvDelimiter(text: string): ',' | '\t' {
  let quoted = false;
  let commas = 0;
  let tabs = 0;
  // Inspect one logical record; separators inside quoted fields are text.
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') i++;
      else quoted = !quoted;
    } else if (!quoted) {
      if (char === '\r' || char === '\n') break;
      if (char === ',') commas++;
      if (char === '\t') tabs++;
    }
  }
  return tabs > commas ? '\t' : ',';
}

export function csvRecords(text: string): Record<string, string | number | null>[] {
  const [headers, ...matrix] = parseCsv(text);
  if (
    !headers?.length ||
    new Set(headers).size !== headers.length ||
    headers.some(name => !name.trim())
  )
    throw new Error('CSV requires unique, non-empty column headers.');
  if (matrix.some(row => row.length > headers.length))
    throw new Error('CSV data has more columns than its header.');
  const numeric = headers.map(
    (_, column) =>
      matrix.some(row => row[column]?.trim()) &&
      matrix.every(row => {
        const text = row[column];
        if (text == null || text === '') return true;
        if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) return false;
        const number = Number(text);
        // Numeric identifiers beyond JS precision must remain exact strings.
        return (
          Number.isFinite(number) &&
          (text.includes('.')
            ? text.replace(/[-.]/g, '').replace(/^0+/, '').length <= 15
            : Number.isSafeInteger(number))
        );
      }),
  );
  return matrix.map(row =>
    Object.fromEntries(
      headers.map((name, column) => [
        name,
        row[column] == null || row[column] === ''
          ? null
          : numeric[column]
            ? Number(row[column])
            : row[column],
      ]),
    ),
  );
}
export function toCsv(rows: unknown[][]): string {
  return (
    '\uFEFF' +
    rows
      .map(row =>
        row
          .map(value => {
            const text = value == null ? '' : String(value);
            // Avoid executing spreadsheet formulas when exported CSV is opened elsewhere.
            const safe = /^[=+@-]/.test(text) && typeof value === 'string' ? `'${text}` : text;
            return `"${safe.replaceAll('"', '""')}"`;
          })
          .join(','),
      )
      .join('\r\n')
  );
}
