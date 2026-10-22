import { z } from 'zod';

import type { Scalar } from './contracts';

const column = z.string().min(1).max(120);
export const analysisTypesSchema = z.record(column, z.enum(['float', 'boolean', 'string']));
export type AnalysisTypes = z.infer<typeof analysisTypesSchema>;
const value = z.union([z.string().max(32768), z.number().finite(), z.boolean(), z.null()]);
const jsonObject = z.record(z.string(), z.json());
// The registered plugins bundled with Perspective 5.6.0. Keep in sync with the
// real viewer via its public getAllPlugins() API in the browser checks.
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
  'Map Scatter',
  'Map Line',
  'Map Density',
] as const;
function validateColumnNames(names: string[]) {
  for (const name of names)
    if (name === '__INDEX__' || name === '__ROW_PATH__')
      throw new Error(`Reserved analysis column: ${name}. Rename this column before importing.`);
}
export const analysisValue = (row: Record<string, Scalar>, name: string): Scalar =>
  Object.hasOwn(row, name) ? (row[name] ?? null) : null;
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
    filter_op: z.enum(['and', 'or']).optional(),
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
      const types = new Set(
        rows
          .map(row => analysisValue(row, name))
          .filter(v => v != null)
          .map(v => typeof v),
      );
      if (types.size > 1)
        throw new Error(`Column "${name}" has mixed value types. Use one scalar type per column.`);
      const type = [...types][0];
      const inferred = type === 'number' ? 'float' : type === 'boolean' ? 'boolean' : 'string';
      const hint = Object.hasOwn(hints, name) ? hints[name] : undefined;
      if (type && hint && hint !== inferred)
        throw new Error(`Column "${name}" does not match its declared type ${hint}.`);
      return [name, hint ?? inferred];
    }),
  ) as Record<string, 'float' | 'boolean' | 'string'>;
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
  return parsed;
}

/** Presentation fields are consumed by the viewer, not the query engine. */
export function analysisEngineConfig(config: z.infer<typeof analysisConfigSchema>) {
  const { version, plugin, plugin_config, columns_config, settings, theme, title, ...engine } =
    config;
  return engine;
}

export const queryWindowSchema = z
  .object({
    offset: z.number().int().min(0).max(500000).default(0),
    limit: z.number().int().min(1).max(100).default(25),
    columnOffset: z.number().int().min(0).max(500000).default(0),
    columnLimit: z.number().int().min(1).max(20).default(20),
  })
  .strict();
