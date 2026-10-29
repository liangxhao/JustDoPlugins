import { z } from 'zod';

import { analysisTypesSchema, analysisConfigSchema } from '../../../shared/analysis';
import { MAX_COLUMNS, MAX_DOCUMENT_BYTES, MAX_ROWS, validateData } from '../../../shared/contracts';
import { csvRecords } from '../../../shared/csv';
import { analysisWorkspaceSchema } from './workspace';
import { inspectArrowInput } from './arrow-input';

export const analysisInputSchema = z.object({
  format: z.enum(['json', 'ndjson', 'columns', 'csv', 'tsv', 'arrow']),
  text: z.string().max(MAX_DOCUMENT_BYTES).optional(),
  blob: z.string().max(Math.ceil(MAX_DOCUMENT_BYTES / 3) * 4).optional(),
  schema: analysisTypesSchema.optional(),
  config: analysisConfigSchema.optional(),
  workspace: analysisWorkspaceSchema.optional(),
}).strict();
export type AnalysisInput = z.infer<typeof analysisInputSchema>;

interface InputView {
  to_json(window?: { start_row?: number; end_row?: number }): Promise<unknown[]>;
  delete(): Promise<unknown>;
}
interface InputTable {
  schema(): Promise<Record<string, string>>;
  size(): Promise<number>;
  view(): Promise<InputView>;
  delete(): Promise<unknown>;
}
export type AnalysisTableFactory = (
  data: ArrayBuffer,
  options?: { list_flatten?: 'stringify' },
) => Promise<InputTable>;

export function base64FromBytes(bytes: Uint8Array): string {
  let value = '';
  for (let offset = 0; offset < bytes.length; offset += 8192)
    value += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(value);
}

export function bytesFromBase64(value: string): Uint8Array {
  if (!value.length || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value))
    throw new Error('Input blob must be valid base64.');
  const bytes = Uint8Array.from(atob(value), char => char.charCodeAt(0));
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) throw new Error('Analysis input exceeds 2 MiB.');
  return bytes;
}

function columnRecords(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Column input must be an object of equally sized arrays.');
  const entries = Object.entries(value);
  if (!entries.length || entries.length > MAX_COLUMNS || entries.some(([, values]) => !Array.isArray(values)))
    throw new Error('Column input requires 1 to 100 array columns.');
  const length = (entries[0][1] as unknown[]).length;
  if (length > MAX_ROWS || entries.some(([, values]) => (values as unknown[]).length !== length))
    throw new Error('Column arrays must have equal lengths and at most 5000 rows.');
  return Array.from({ length }, (_, index) => Object.fromEntries(
    entries.map(([name, values]) => [name, (values as unknown[])[index]]),
  ));
}

/** Pure text parsing preserves strings such as identifiers with leading zeroes. */
export async function parseAnalysisInput(
  untrusted: AnalysisInput,
  createTable?: AnalysisTableFactory,
): Promise<Record<string, unknown>> {
  const input = analysisInputSchema.parse(untrusted);
  if ((input.text === undefined) === (input.blob === undefined))
    throw new Error('Provide exactly one of text or blob.');
  let data: Record<string, unknown>;
  if (input.format === 'arrow') {
    if (input.blob === undefined || !createTable)
      throw new Error('Arrow input requires a binary blob and the local engine.');
    const bytes = bytesFromBase64(input.blob);
    inspectArrowInput(bytes);
    let table: InputTable | undefined, view: InputView | undefined;
    try {
      table = await createTable(bytes.buffer as ArrayBuffer, { list_flatten: 'stringify' });
      const schema = await table.schema();
      const size = await table.size();
      if (Object.keys(schema).length > MAX_COLUMNS || size > MAX_ROWS)
        throw new Error('Arrow input exceeds 5000 rows or 100 columns.');
      view = await table.view();
      const rows: unknown[] = [];
      let jsonBytes = 0;
      // A compact dictionary and repeated column names can expand substantially
      // in JSON. Stop incrementally instead of materializing every row first.
      for (let offset = 0; offset < size; offset += 64) {
        const page = await view.to_json({ start_row: offset, end_row: Math.min(size, offset + 64) });
        jsonBytes += new TextEncoder().encode(JSON.stringify(page)).byteLength;
        if (jsonBytes > MAX_DOCUMENT_BYTES) throw new Error('Decoded Arrow records exceed 2 MiB.');
        rows.push(...page);
      }
      // JSON numbers cannot carry arbitrary Arrow int64 values losslessly.
      for (const row of rows as Record<string, unknown>[])
        for (const [name, type] of Object.entries(schema))
          if (type === 'integer' && row[name] != null && !Number.isSafeInteger(row[name]))
            throw new Error(`Arrow integer column "${name}" exceeds exact JSON number precision.`);
      data = { rows, schema: { ...schema, ...input.schema } };
    } finally {
      try { await view?.delete(); } finally { await table?.delete(); }
    }
  } else {
    const text = input.text ?? new TextDecoder('utf-8', { fatal: true }).decode(bytesFromBase64(input.blob!));
    if (new TextEncoder().encode(text).byteLength > MAX_DOCUMENT_BYTES)
      throw new Error('Analysis input exceeds 2 MiB.');
    const source = text.replace(/^\uFEFF/, '');
    if (input.format === 'ndjson') {
      const lines = source.split(/\r\n|\n|\r/).map((text, index) => ({ text, index })).filter(line => line.text.trim());
      if (lines.length > MAX_ROWS) throw new Error('At most 5000 data rows are supported.');
      data = { rows: lines.map(line => {
        try { return JSON.parse(line.text); }
        catch { throw new Error(`Invalid NDJSON record on line ${line.index + 1}.`); }
      }) };
    } else if (input.format === 'csv' || input.format === 'tsv') data = { rows: csvRecords(source) };
    else {
      const value: unknown = JSON.parse(source);
      if (input.format === 'columns') data = { rows: columnRecords(value) };
      else if (Array.isArray(value)) data = { rows: value };
      else if (value && typeof value === 'object' && Object.hasOwn(value, 'rows'))
        data = value as Record<string, unknown>;
      else data = { rows: columnRecords(value) };
    }
  }
  return validateData('perspective', {
    ...data,
    ...(input.schema ? { schema: { ...(data.schema as object | undefined), ...input.schema } } : {}),
    ...(input.config ? { config: input.config } : {}),
    ...(input.workspace !== undefined ? { workspace: input.workspace } : {}),
  });
}
