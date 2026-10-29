import { z } from 'zod';

import type { Scalar } from './contracts';

const column = z.string().min(1).max(120);
export const analysisTypesSchema = z.record(
  column,
  z.enum(['float', 'integer', 'boolean', 'string', 'date', 'datetime']),
);
export type AnalysisTypes = z.infer<typeof analysisTypesSchema>;
const value = z.union([z.string().max(32768), z.number().finite(), z.boolean(), z.null()]);
const jsonObject = z.record(z.string(), z.json());
// Offline renderers from the locked public distribution. Map renderers need
// external tiles and are deliberately outside this App's contract.
export const analysisPlugins = [
  'Datagrid',
  'X Bar',
  'Y Bar',
  'Y Line',
  'Y Scatter',
  'Y Area',
  'X/Y Scatter',
  'X/Y Line',
  'Density',
  'Treemap',
  'Sunburst',
  'Heatmap',
  'Candlestick',
  'OHLC',
] as const;
function validateColumnNames(names: string[]) {
  for (const name of names)
    if (name === '__INDEX__' || name === '__ROW_PATH__')
      throw new Error(`Reserved analysis column: ${name}. Rename this column before importing.`);
}
export const analysisValue = (row: Record<string, Scalar>, name: string): Scalar =>
  Object.hasOwn(row, name) ? (row[name] ?? null) : null;

const dayMilliseconds = 86400000;
const decimalTimestamp = /^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;
function calendarDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const milliseconds = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString().slice(0, 10) === value
    ? milliseconds
    : undefined;
}

/** Preserve JSON-safe source values without the engine's lossy coercions. */
export function normalizeAnalysisValue(value: Scalar, type: AnalysisTypes[string], name: string): Scalar {
  if (value === null) return null;
  const fail = () => {
    throw new Error(`Column "${name}" does not match its declared type ${type}.`);
  };
  if (type === 'string') return typeof value === 'string' ? value : fail();
  if (type === 'boolean') return typeof value === 'boolean' ? value : fail();
  if (type === 'float') return typeof value === 'number' && Number.isFinite(value) ? value : fail();
  if (type === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < -2147483648 || value > 2147483647)
      throw new Error(`Column "${name}" requires a 32-bit integer. Use float or string for larger values.`);
    return value;
  }
  let milliseconds: number | undefined;
  if (typeof value === 'number') milliseconds = value;
  else if (typeof value === 'string') {
    if (type === 'date') milliseconds = calendarDate(value);
    else {
      const match = decimalTimestamp.exec(value);
      if (match && calendarDate(value.slice(0, 10)) !== undefined &&
        Number(match[1]) < 24 && Number(match[2]) < 60 && Number(match[3]) < 60) {
        const zone = match[5];
        if (zone === 'Z' || (Number(zone.slice(1, 3)) < 24 && Number(zone.slice(4, 6)) < 60))
          milliseconds = Date.parse(value);
      }
    }
  }
  if (milliseconds === undefined || !Number.isSafeInteger(milliseconds) ||
    Math.abs(milliseconds) > 8640000000000000 ||
    (type === 'date' && (milliseconds % dayMilliseconds !== 0 ||
      milliseconds < -62167219200000 || milliseconds > 253402214400000))) return fail();
  return milliseconds;
}
export const analysisConfigSchema = z
  .object({
    version: z.string().max(64).optional(),
    plugin: z.enum(analysisPlugins).nullable().optional(),
    title: z.string().max(120).nullable().optional(),
    theme: z.string().max(120).nullable().optional(),
    settings: z.boolean().optional(),
    plugin_config: jsonObject.nullable().optional(),
    columns_config: z.record(column, jsonObject).nullable().optional(),
    group_by: z.array(column).max(100).optional(),
    split_by: z.array(column).max(100).optional(),
    columns: z.array(column.nullable()).max(100).optional(),
    filter: z
      .array(
        z.tuple([column, z.string().min(1).max(80), z.union([value, z.array(value).max(5000)])]),
      )
      .max(100)
      .optional(),
    sort: z
      .array(
        z.tuple([
          column,
          z.enum([
            'none',
            'asc',
            'desc',
            'asc abs',
            'desc abs',
            'col asc',
            'col desc',
            'col asc abs',
            'col desc abs',
          ]),
        ]),
      )
      .max(100)
      .optional(),
    aggregates: z
      .record(
        column,
        z.union([
          z.string().min(1).max(120),
          z.tuple([z.string().max(120), z.array(column).max(100)]),
        ]),
      )
      .optional(),
    expressions: z.record(column, z.string().max(8192)).optional(),
    windows: jsonObject.optional(),
    group_by_depth: z.number().int().min(0).max(100).nullable().optional(),
    filter_op: z.enum(['and'], { error: 'This viewer preserves AND filters only. Use an expression boolean column for OR conditions.' }).optional(),
    group_rollup_mode: z.string().max(32).optional(),
    split_rollup_mode: z.string().max(32).optional(),
  })
  .strict();

/** Use all records, rather than inferring columns/types from the first row. */
export function analysisSchema(rows: Record<string, Scalar>[], declared?: unknown) {
  const hints: AnalysisTypes = declared === undefined ? {} : analysisTypesSchema.parse(declared);
  const columns = [...new Set([...Object.keys(hints), ...rows.flatMap(row => Object.keys(row))])];
  validateColumnNames(columns);
  if (columns.length > 100) throw new Error('At most 100 columns are supported.');
  if (rows.length && !columns.length)
    throw new Error('Analysis records require at least one column.');
  return Object.fromEntries(
    columns.map(name => {
      const values = rows.map(row => analysisValue(row, name)).filter(v => v !== null);
      const hint = Object.hasOwn(hints, name) ? hints[name] : undefined;
      if (hint) {
        for (const item of values) normalizeAnalysisValue(item, hint, name);
        return [name, hint];
      }
      const types = new Set(values.map(v => typeof v));
      if (types.size > 1)
        throw new Error(`Column "${name}" has mixed value types. Use one scalar type per column.`);
      const type = [...types][0];
      const inferred = type === 'number' ? 'float' : type === 'boolean' ? 'boolean' : 'string';
      return [name, inferred];
    }),
  ) as AnalysisTypes;
}

export function normalizeAnalysisRows(rows: Record<string, Scalar>[], declared?: unknown) {
  const schema = analysisSchema(rows, declared);
  return {
    rows: rows.map(row => Object.fromEntries(
      Object.entries(row).map(([name, item]) => [name, normalizeAnalysisValue(item, schema[name], name)]),
    )),
    schema,
  };
}

export function validateAnalysisConfig(
  config: unknown,
  rows: Record<string, Scalar>[],
  declared?: unknown,
) {
  const parsed = analysisConfigSchema.parse(config ?? {});
  const schema = analysisSchema(rows, declared);
  validateColumnNames([
    ...Object.keys(parsed.expressions ?? {}),
    ...Object.keys(parsed.windows ?? {}),
  ]);
  const names = new Set([
    ...Object.keys(schema),
    ...Object.keys(parsed.expressions ?? {}),
    ...Object.keys(parsed.windows ?? {}),
  ]);
  for (const name of [
    ...(parsed.group_by ?? []),
    ...(parsed.split_by ?? []),
    ...(parsed.columns ?? []),
    ...(parsed.filter ?? []).map(item => item[0]),
    ...(parsed.sort ?? []).map(item => item[0]),
    ...Object.keys(parsed.aggregates ?? {}),
  ]) {
    if (name !== null && !names.has(name)) throw new Error(`Unknown analysis column: ${name}`);
  }
  return normalizeAnalysisFilters(parsed, schema);
}

/** Also used after engine expression/window types become available. */
export function normalizeAnalysisFilters(config: z.infer<typeof analysisConfigSchema>, types: AnalysisTypes): z.infer<typeof analysisConfigSchema> {
  if (!config.filter) return config;
  return { ...config, filter: config.filter.map(([name, operator, item]) => {
      const type = types[name];
      if (type && ['==', '!=', '>', '<', '>=', '<=', 'in', 'not in',
        'contains', 'not contain', 'begins with', 'ends with'].includes(operator)) {
        const list = operator === 'in' || operator === 'not in';
        if (list !== Array.isArray(item))
          throw new Error(`Filter "${name}" ${operator} requires ${list ? 'an array' : 'a scalar'} operand.`);
        return [name, operator, Array.isArray(item)
          ? item.map(value => normalizeAnalysisValue(value, type, name))
          : normalizeAnalysisValue(item, type, name)];
      }
      return [name, operator, item];
    }) };
}

/** Presentation fields are consumed by the viewer, not the query engine. */
export function analysisEngineConfig(config: z.infer<typeof analysisConfigSchema>) {
  const { version, plugin, plugin_config, columns_config, settings, theme, title, ...engine } =
    config;
  return engine;
}

export const queryWindowSchema = z
  .object({
    panelId: z.string().min(1).max(128).optional(),
    offset: z.number().int().min(0).max(500000).default(0),
    limit: z.number().int().min(1).max(100).default(25),
    columnOffset: z.number().int().min(0).max(500000).default(0),
    columnLimit: z.number().int().min(1).max(20).default(20),
  })
  .strict();

export const analysisInspectSchema = z.object({
  panelId: z.string().min(1).max(128).optional(),
  plugin: z.enum(analysisPlugins).optional(),
  column: column.optional(),
  section: z.enum(['styles', 'expressions', 'windows', 'configuration', 'all']).default('styles'),
  search: z.string().max(120).optional(),
  limit: z.number().int().min(1).max(20).default(8),
}).strict();
export type AnalysisInspectOptions = z.infer<typeof analysisInspectSchema>;
export type AnalysisQueryWindow = z.infer<typeof queryWindowSchema>;
