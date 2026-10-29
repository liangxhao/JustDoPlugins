import { normalizeAnalysisValue, type AnalysisTypes } from '../../../shared/analysis';
import { scalar, type Scalar } from '../../../shared/contracts';

interface CellMetadata {
  type?: string;
  column_header?: unknown[];
}

export interface NativeEditTable extends HTMLElement {
  getMeta(cell: HTMLElement): CellMetadata | undefined;
}

// Match the complete input before the native editor's parseFloat can discard a
// suffix. Commas are accepted only as complete groups of three decimal digits.
const decimal = /^[+-]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

export function normalizeNativeEdit(text: string, type: AnalysisTypes[string], column: string): Scalar {
  let value: Scalar = scalar.parse(text);
  if (type === 'float' || type === 'integer') {
    const input = text.trim();
    if (!decimal.test(input)) throw new Error('Enter a complete decimal number.');
    value = Number(input.replaceAll(',', ''));
  }
  return normalizeAnalysisValue(value, type, column);
}

/** Validate text edits before the locked Datagrid's native focusout writer. */
export function createNativeEditGuard(options: {
  schema(): AnalysisTypes;
  invalid(column: string, type: AnalysisTypes[string]): void;
  valid?(): void;
  signal: AbortSignal;
}) {
  const attached = new WeakSet<NativeEditTable>();
  return (table: NativeEditTable) => {
    if (options.signal.aborted || attached.has(table)) return;
    attached.add(table);
    const originals = new WeakMap<HTMLElement, { text: string; column: string }>();
    const columnFor = (cell: HTMLElement) => {
      const meta = table.getMeta(cell);
      const column = meta?.column_header?.at(-1);
      return meta?.type === 'body' && typeof column === 'string' && Object.hasOwn(options.schema(), column)
        ? column
        : undefined;
    };
    const remember = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement) || target.tagName !== 'TD') return;
      const column = columnFor(target);
      if (column) originals.set(target, { text: target.textContent ?? '', column });
    };
    table.addEventListener('focusin', event => remember(event.target), { capture: true, signal: options.signal });
    table.addEventListener('focusout', event => {
      const cell = event.target;
      if (!(cell instanceof HTMLElement) || cell.tagName !== 'TD') return;
      const original = originals.get(cell);
      originals.delete(cell);
      if (!original || original.text === cell.textContent || columnFor(cell) !== original.column) return;
      const type = options.schema()[original.column];
      try {
        normalizeNativeEdit(cell.textContent ?? '', type, original.column);
        options.valid?.();
      } catch {
        // The native listener compares against the same focusin text. Restoring
        // it prevents Table.update while allowing its focus/selection cleanup.
        cell.textContent = original.text;
        options.invalid(original.column, type);
      }
    }, { capture: true, signal: options.signal });
    const root = table.getRootNode();
    if (root instanceof ShadowRoot || root instanceof Document) remember(root.activeElement);
  };
}
