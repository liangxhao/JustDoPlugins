import {
  createNumberFormatter,
  createDatetimeFormatter,
  createDateFormatter,
  type NumberFormatConfig,
  type DateFormatConfig,
} from '@perspective-dev/viewer/column-format';

export interface StyleField {
  kind: string;
  key?: string;
  fields?: StyleField[];
  variants?: { value: unknown }[];
  min?: number;
  max?: number;
  size?: StyleField;
  bold?: StyleField;
  italic?: StyleField;
  corners?: boolean;
}
export interface StyleSchema {
  fields: StyleField[];
}

/** The viewer accepts a smaller color grammar than general browser CSS. */
function validCss(value: unknown, kind: 'Color' | 'GradientStops' | 'Palette'): boolean {
  if (typeof value !== 'string' || value.length > 8192) return false;
  const text = value.trim();
  const variable = kind === 'GradientStops' ? 'gradient' : kind.toLowerCase();
  if (new RegExp(`^var\\(\\s*--psp-user--${variable}-[^\\s,)]+\\s*\\)$`).test(text)) return true;
  const color = (input: string) => {
    if (/^#(?:[a-f\d]{3}|[a-f\d]{4}|[a-f\d]{6}|[a-f\d]{8})$/i.test(input)) return true;
    const match = /^rgba?\((.*)\)$/i.exec(input);
    if (!match) return false;
    const tokens = match[1]
      .split('/')[0]
      .split(/[,\s]+/)
      .filter(Boolean);
    const number = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
    return (
      tokens.length >= 3 &&
      tokens.length <= 4 &&
      tokens
        .slice(0, 3)
        .every(
          token =>
            number.test(token.replace(/%$/, '')) &&
            Number.isFinite(Number(token.replace(/%$/, ''))),
        )
    );
  };
  if (kind === 'Color') return color(text);
  const match = /^linear-gradient\((.*)\)$/is.exec(text);
  if (!match) return false;
  const entries: string[] = [];
  let depth = 0,
    start = 0;
  for (let i = 0; i < match[1].length; i++) {
    const char = match[1][i];
    if (char === '(') depth++;
    if (char === ')' && --depth < 0) return false;
    if (char === ',' && depth === 0) {
      entries.push(match[1].slice(start, i).trim());
      start = i + 1;
    }
  }
  if (depth !== 0) return false;
  entries.push(match[1].slice(start).trim());
  if (
    /^(?:to\s|[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:deg|rad|grad|turn)$)/i.test(entries[0])
  )
    entries.shift();
  if (entries.length < (kind === 'Palette' ? 1 : 2)) return false;
  return entries.every(entry => {
    const position = /^(.*)\s+([+-]?(?:\d*\.?\d+)(?:e[+-]?\d+)?%)$/i.exec(entry);
    if (position && kind === 'Palette') return false;
    return color(position ? position[1].trim() : entry);
  });
}

/** Use the same public formatters as the viewer, including Intl option checks. */
export function validateFormatOptions(value: Record<string, unknown>) {
  if (value.number_format != null) {
    if (typeof value.number_format !== 'object' || Array.isArray(value.number_format))
      throw new Error('number_format must be an options object.');
    createNumberFormatter('float', value.number_format as NumberFormatConfig).format(1.25);
  }
  if (value.date_format != null) {
    if (typeof value.date_format !== 'object' || Array.isArray(value.date_format))
      throw new Error('date_format must be an options object.');
    createDatetimeFormatter(value.date_format as DateFormatConfig).format(new Date(0));
    createDateFormatter(value.date_format as DateFormatConfig).format(new Date(0));
  }
}

/** Validate values against the bundled plugin's own public dynamic style schema. */
export function validateStyleFields(
  value: Record<string, unknown>,
  schema: StyleSchema,
  allowUnknown = false,
) {
  const fields = new Map<string, StyleField[]>();
  function collect(items: StyleField[]) {
    for (const field of items) {
      if (field.kind === 'Group') {
        collect(field.fields ?? []);
        continue;
      }
      const key =
        field.key ??
        (field.kind === 'NumberFormat'
          ? 'number_format'
          : field.kind === 'DatetimeFormat'
            ? 'date_format'
            : field.kind === 'AggregateDepth'
              ? 'aggregate_depth'
              : undefined);
      if (key) fields.set(key, [...(fields.get(key) ?? []), field]);
      if (field.kind === 'Font')
        collect([
          ...(field.size ? [{ ...field.size, kind: 'Number' }] : []),
          ...(field.bold ? [{ ...field.bold, kind: 'Bool' }] : []),
          ...(field.italic ? [{ ...field.italic, kind: 'Bool' }] : []),
        ]);
    }
  }
  collect(schema.fields);
  validateFormatOptions(value);
  for (const [key, item] of Object.entries(value)) {
    if (item == null) continue;
    const choices = fields.get(key);
    if (!choices) {
      if (!allowUnknown) throw new Error(`Unknown analysis style field: ${key}`);
      continue;
    }
    const valid = choices.some(field => {
      switch (field.kind) {
        case 'Bool':
          return typeof item === 'boolean';
        case 'Enum':
          return field.variants?.some(variant => variant.value === item);
        case 'Number':
          return (
            typeof item === 'number' &&
            Number.isFinite(item) &&
            (field.min == null || item >= field.min) &&
            (field.max == null || item <= field.max)
          );
        case 'AggregateDepth':
          return typeof item === 'number' && Number.isInteger(item) && item >= 0 && item <= 100;
        case 'Alignment':
          return (
            typeof item === 'string' &&
            (field.corners
              ? ['top-left', 'top-right', 'bottom-left', 'bottom-right']
              : [
                  'top-left',
                  'top',
                  'top-right',
                  'left',
                  'center',
                  'right',
                  'bottom-left',
                  'bottom',
                  'bottom-right',
                ]
            ).includes(item)
          );
        case 'NumberFormat':
        case 'DatetimeFormat':
          return typeof item === 'object' && !Array.isArray(item);
        case 'Color':
        case 'GradientStops':
        case 'Palette':
          return validCss(item, field.kind);
        case 'Font':
          return typeof item === 'string' && item.length <= 8192;
        default:
          throw new Error(`Unsupported bundled style schema kind: ${field.kind}`);
      }
    });
    if (!valid) throw new Error(`Invalid analysis style value: ${key}`);
  }
}
