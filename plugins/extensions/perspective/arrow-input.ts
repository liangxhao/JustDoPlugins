import { MAX_COLUMNS, MAX_DOCUMENT_BYTES, MAX_ROWS } from '../../../shared/contracts';

export const MAX_ARROW_BODY_BYTES = 16 * 1024 * 1024;
function fail(message: string): never { throw new Error(`Invalid Arrow input: ${message}`); }

/** A range-checked reader for the fixed IPC metadata structures, not array data.
 * Layouts: https://github.com/apache/arrow/tree/main/format
 * Message.fbs (Message/RecordBatch/DictionaryBatch), Schema.fbs, File.fbs.
 * Actual array decoding and codec validation remain with the public engine.
 */
class Metadata {
  readonly view: DataView;
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  range(offset: number, size: number) {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 ||
      offset > this.bytes.length - size) fail('truncated or out-of-range metadata.');
    return offset;
  }
  u8(offset: number) { return this.view.getUint8(this.range(offset, 1)); }
  u16(offset: number) { return this.view.getUint16(this.range(offset, 2), true); }
  i16(offset: number) { return this.view.getInt16(this.range(offset, 2), true); }
  u32(offset: number) { return this.view.getUint32(this.range(offset, 4), true); }
  i32(offset: number) { return this.view.getInt32(this.range(offset, 4), true); }
  integer(offset: number, maximum = Number.MAX_SAFE_INTEGER, minimum = 0) {
    const value = this.view.getBigInt64(this.range(offset, 8), true);
    if (value < BigInt(minimum) || value > BigInt(maximum)) fail('integer capacity or offset exceeds its limit.');
    return Number(value);
  }
  reference(offset: number) {
    const displacement = this.u32(offset);
    if (!displacement) fail('missing FlatBuffer reference.');
    return this.range(offset + displacement, 4);
  }
  root() { return this.table(this.reference(0)); }
  table(offset: number) {
    const vtable = offset - this.i32(offset);
    const length = this.u16(vtable), size = this.u16(vtable + 2);
    if (length < 4 || length % 2 || size < 4) fail('invalid FlatBuffer table.');
    this.range(vtable, length);
    this.range(offset, size);
    return offset;
  }
  field(table: number, index: number, width: number) {
    this.table(table);
    const vtable = table - this.i32(table), entry = 4 + index * 2;
    if (entry + 2 > this.u16(vtable)) return undefined;
    const relative = this.u16(vtable + entry);
    if (!relative) return undefined;
    if (relative < 4 || relative > this.u16(vtable + 2) - width) fail('invalid FlatBuffer field.');
    return this.range(table + relative, width);
  }
  target(table: number, index: number) {
    const field = this.field(table, index, 4);
    return field === undefined ? undefined : this.table(this.reference(field));
  }
  vector(table: number, index: number, stride: number, maximum = 65536) {
    const field = this.field(table, index, 4);
    if (field === undefined) return { start: 0, length: 0 };
    const vector = this.reference(field), length = this.u32(vector), start = vector + 4;
    if (length > maximum) fail('metadata vector is too large.');
    this.range(start, length * stride);
    return { start, length };
  }
  string(table: number, index: number) {
    const field = this.field(table, index, 4);
    if (field === undefined) fail('missing field name.');
    const string = this.reference(field), length = this.u32(string);
    if (length > 480) fail('field name is too long.');
    this.range(string + 4, length + 1);
    if (this.u8(string + 4 + length)) fail('unterminated field name.');
    return new TextDecoder('utf-8', { fatal: true }).decode(this.bytes.subarray(string + 4, string + 4 + length));
  }
}

export interface ArrowInputMetadata { rows: number; columns: number; expandedBytes: number; }

/** Check every allocation-bearing IPC batch before any decompression or engine call. */
export function inspectArrowInput(bytes: Uint8Array): ArrowInputMetadata {
  if (!bytes.length || bytes.length > MAX_DOCUMENT_BYTES) fail('binary input must fit within 2 MiB.');
  const input = new Metadata(bytes);
  const stats: ArrowInputMetadata = { rows: 0, columns: 0, expandedBytes: 0 };
  let schemaSeen = false, messages = 0, cells = 0, buffers = 0;
  type PhysicalField = { physical: number; unit?: number; dictionary?: string };
  let recordFields: PhysicalField[] = [];
  const dictionaryTypes = new Map<string, PhysicalField>();
  const dictionaryValueBytes = new Map<string, number>();
  const dictionaryId = (meta: Metadata, table: number) => {
    const field = meta.field(table, 0, 8);
    return field === undefined ? '0' : meta.view.getBigInt64(meta.range(field, 8), true).toString();
  };
  function schema(meta: Metadata, table: number) {
    const fields = meta.vector(table, 1, 4, MAX_COLUMNS);
    stats.columns = Math.max(stats.columns, fields.length);
    schemaSeen = true;
    recordFields = [];
    let count = 0;
    const ancestors = new Set<number>();
    function walk(vector: { start: number; length: number }, depth: number, record = true) {
      if (depth > 8) fail('nested schema is too deep.');
      const names = new Set<string>();
      for (let index = 0; index < vector.length; index++) {
        if (++count > 1000) fail('nested schema has too many fields.');
        const field = meta.table(meta.reference(vector.start + index * 4));
        if (ancestors.has(field)) fail('cyclic schema.');
        const name = meta.string(field, 0);
        if (!name || names.has(name)) fail('empty or repeated field names.');
        names.add(name);
        const type = meta.field(field, 2, 1);
        if (type === undefined || meta.u8(type) < 1 || meta.u8(type) > 26) fail('unsupported physical field type.');
        const physical = meta.u8(type);
        let unit: number | undefined;
        // The document has six scalar logical types. Decimal, binary, nested,
        // time-of-day and view/run-end arrays need a different lossless contract.
        if (![1, 2, 3, 5, 6, 8, 10, 20].includes(physical)) fail('only scalar integer, float, boolean, UTF-8, date and datetime arrays are supported.');
        const typeTable = meta.target(field, 3);
        if (typeTable === undefined && physical !== 1) fail('physical type parameters are missing.');
        if (typeTable !== undefined) {
          if (physical === 2) {
            const width = meta.field(typeTable, 0, 4);
            if (width === undefined || ![8, 16, 32, 64].includes(meta.i32(width))) fail('invalid integer bit width.');
          } else if (physical === 3) {
            const precision = meta.field(typeTable, 0, 2);
            if (precision === undefined || ![1, 2].includes(meta.i16(precision))) fail('only float32/float64 arrays are supported.');
          } else if (physical === 10) {
            const value = meta.field(typeTable, 0, 2);
            unit = value === undefined ? 0 : meta.i16(value);
            if (![0, 1].includes(unit)) fail('sub-millisecond timestamps are not supported.');
          } else if (physical === 8) {
            const value = meta.field(typeTable, 0, 2);
            unit = value === undefined ? 1 : meta.i16(value);
            if (![0, 1].includes(unit)) fail('invalid date unit.');
          }
        }
        const dictionary = meta.target(field, 4);
        let id: string | undefined;
        if (dictionary !== undefined) {
          meta.target(dictionary, 1);
          id = dictionaryId(meta, dictionary);
          const previous = dictionaryTypes.get(id);
          if (previous && (previous.physical !== physical || previous.unit !== unit)) fail('dictionary type changes.');
          dictionaryTypes.set(id, { physical, unit });
        }
        if (record) recordFields.push({ physical, unit, ...(id === undefined ? {} : { dictionary: id }) });
        ancestors.add(field);
        const children = meta.vector(field, 5, 4, 1000);
        if (children.length) fail('nested arrays are not supported.');
        walk(children, depth + 1, record && dictionary === undefined);
        ancestors.delete(field);
      }
    }
    walk(fields, 0);
  }
  function batch(meta: Metadata, table: number, bodyStart: number, bodyLength: number, dictionary?: string) {
    const lengthField = meta.field(table, 0, 8);
    const length = lengthField === undefined ? 0 : meta.integer(lengthField, MAX_ROWS * MAX_COLUMNS);
    if (dictionary === undefined) {
      stats.rows += length;
      if (stats.rows > MAX_ROWS) fail('at most 5000 rows are supported.');
    }
    const nodes = meta.vector(table, 1, 16);
    if (dictionary === undefined && nodes.length !== recordFields.length) fail('record nodes do not match the schema.');
    if (dictionary !== undefined && nodes.length !== 1) fail('dictionary must contain one scalar node.');
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes.start + index * 16;
      const size = meta.integer(node, MAX_ROWS * MAX_COLUMNS);
      if (size !== length) fail('scalar array length does not match its batch.');
      meta.integer(node + 8, size);
      cells += size;
      if (cells > MAX_ROWS * MAX_COLUMNS) fail('array element capacity exceeds 500000.');
      const id = dictionary === undefined ? recordFields[index]?.dictionary : undefined;
      if (id !== undefined) {
        const valueBytes = dictionaryValueBytes.get(id);
        if (valueBytes === undefined) fail('dictionary data is missing.');
        stats.expandedBytes += size * valueBytes;
        if (stats.expandedBytes > MAX_ARROW_BODY_BYTES) fail('dictionary expansion exceeds 16 MiB.');
      }
    }
    const compression = meta.target(table, 3);
    if (compression !== undefined) {
      const codec = meta.field(compression, 0, 1), method = meta.field(compression, 1, 1);
      if ((codec !== undefined && meta.u8(codec) > 1) || (method !== undefined && meta.u8(method) !== 0))
        fail('unsupported buffer compression.');
    }
    const ranges = meta.vector(table, 2, 16);
    const bufferInfo: { expanded: number; raw?: number }[] = [];
    buffers += ranges.length;
    if (buffers > 65536) fail('too many array buffers.');
    for (let index = 0; index < ranges.length; index++) {
      const range = ranges.start + index * 16;
      const offset = meta.integer(range, bodyLength), size = meta.integer(range + 8, bodyLength);
      if (offset > bodyLength - size) fail('array buffer exceeds its message body.');
      let expanded = size;
      let raw: number | undefined = bodyStart + offset;
      if (compression !== undefined && size) {
        if (size < 8) fail('truncated compressed buffer.');
        expanded = input.integer(bodyStart + offset, MAX_ARROW_BODY_BYTES, -1);
        if (expanded === -1) { expanded = size - 8; raw += 8; }
        else raw = undefined;
      }
      stats.expandedBytes += expanded;
      if (stats.expandedBytes > MAX_ARROW_BODY_BYTES) fail('expanded array buffers exceed 16 MiB.');
      bufferInfo.push({ expanded, raw });
    }
    const temporal = (field: PhysicalField, dataIndex: number, nodeIndex: number) => {
      if (field.dictionary !== undefined || ![8, 10].includes(field.physical)) return;
      const node = nodes.start + nodeIndex * 16;
      const nulls = meta.integer(node + 8, length);
      if (nulls === length) return;
      const data = bufferInfo[dataIndex + 1], validity = bufferInfo[dataIndex];
      // Date years are narrower in the engine, and seconds are multiplied by
      // 1000. Verify the original integers so either conversion cannot wrap.
      const requiresRaw = field.physical === 8 || field.unit === 0;
      if (!requiresRaw && data?.raw === undefined) return;
      if (!data || data.raw === undefined || (nulls && validity?.raw === undefined))
        fail('compressed date or second-precision timestamp values cannot be verified; export uncompressed Arrow.');
      const width = field.physical === 8 && field.unit === 0 ? 4 : 8;
      if (data.expanded < length * width || (nulls && validity.expanded < Math.ceil(length / 8)))
        fail('temporal array buffers are truncated.');
      for (let index = 0; index < length; index++) {
        if (nulls && !(input.u8(validity.raw! + (index >> 3)) & (1 << (index % 8)))) continue;
        let value = width === 4 ? BigInt(input.i32(data.raw + index * width))
          : input.view.getBigInt64(input.range(data.raw + index * width, 8), true);
        if (field.physical === 8 && field.unit === 0) value *= 86400000n;
        else if (field.physical === 10 && field.unit === 0) value *= 1000n;
        if (field.physical === 8) {
          if (value < -62167219200000n || value > 253402214400000n || value % 86400000n)
            fail('date values require UTC midnight in years 0000 through 9999.');
        } else if (value < -8640000000000000n || value > 8640000000000000n)
          fail('datetime values exceed the supported epoch range.');
      }
    };
    if (dictionary !== undefined) {
      const spec = dictionaryTypes.get(dictionary);
      if (spec === undefined) fail('dictionary ID is not present in the schema.');
      temporal(spec, 0, 0);
      const physical = spec.physical;
      let maximum = 0;
      if ([4, 5, 19, 20].includes(physical)) {
        const offsets = bufferInfo[1], data = bufferInfo[2];
        if (!offsets || !data) fail('dictionary string buffers are missing.');
        maximum = data.expanded;
        if (offsets.raw !== undefined) {
          const width = physical === 19 || physical === 20 ? 8 : 4;
          if ((length + 1) * width > offsets.expanded) fail('dictionary offsets are truncated.');
          const at = (index: number) => width === 8
            ? input.integer(offsets.raw! + index * width, data.expanded)
            : input.u32(offsets.raw! + index * width);
          maximum = 0;
          let previous = at(0);
          for (let index = 1; index <= length; index++) {
            const next = at(index);
            if (next < previous || next > data.expanded) fail('dictionary string offsets are invalid.');
            maximum = Math.max(maximum, next - previous);
            previous = next;
          }
        }
      } else if (physical === 15) maximum = bufferInfo[1]?.expanded ?? 0;
      dictionaryValueBytes.set(dictionary, Math.max(dictionaryValueBytes.get(dictionary) ?? 0, maximum));
    } else {
      let cursor = 0;
      for (let index = 0; index < recordFields.length; index++) {
        const field = recordFields[index];
        temporal(field, cursor, index);
        cursor += field.dictionary !== undefined ? 2 : field.physical === 1 ? 0
          : [5, 20].includes(field.physical) ? 3 : 2;
      }
      if (cursor !== bufferInfo.length) fail('array buffers do not match the scalar schema.');
    }
    // Newer variable-buffer array layouts carry additional allocation counts.
    const variadic = meta.vector(table, 4, 8);
    for (let index = 0; index < variadic.length; index++)
      meta.integer(variadic.start + index * 8, 65536);
  }
  function message(offset: number, end: number, expected?: number) {
    if (++messages > MAX_ROWS + 2 * MAX_COLUMNS + 8) fail('too many IPC messages.');
    input.range(offset, 4);
    let metadataLength = input.u32(offset), prefix = 4;
    if (metadataLength === 0xffffffff) {
      metadataLength = input.u32(offset + 4);
      prefix = 8;
    }
    if (!metadataLength) return { next: offset + prefix, metadataLength: prefix, bodyLength: 0, type: 0 };
    const metadataStart = offset + prefix, bodyStart = metadataStart + metadataLength;
    if (bodyStart > end) fail('truncated message metadata.');
    const meta = new Metadata(bytes.subarray(metadataStart, bodyStart)), root = meta.root();
    const version = meta.field(root, 0, 2), typeField = meta.field(root, 1, 1);
    if (version === undefined || ![3, 4].includes(meta.i16(version))) fail('only IPC metadata V4/V5 is supported.');
    const type = typeField === undefined ? 0 : meta.u8(typeField);
    if (expected !== undefined && type !== expected) fail('file block type does not match its footer.');
    const header = meta.target(root, 2), bodyField = meta.field(root, 3, 8);
    const bodyLength = bodyField === undefined ? 0 : meta.integer(bodyField, MAX_DOCUMENT_BYTES);
    if (header === undefined || bodyStart > end - bodyLength) fail('truncated message body.');
    if (type === 1) {
      if (bodyLength) fail('schema message has an unexpected body.');
      schema(meta, header);
    } else if (type === 2 || type === 3) {
      if (!schemaSeen) fail('batch appears before its schema.');
      const record = type === 2 ? meta.target(header, 1) : header;
      if (record === undefined) fail('dictionary has no data batch.');
      batch(meta, record, bodyStart, bodyLength, type === 2 ? dictionaryId(meta, header) : undefined);
    } else fail('only schema, dictionary and record batch messages are supported.');
    return { next: bodyStart + bodyLength, metadataLength: prefix + metadataLength, bodyLength, type };
  }
  const magic = (offset: number) => offset >= 0 && offset + 6 <= bytes.length &&
    [65, 82, 82, 79, 87, 49].every((value, index) => bytes[offset + index] === value);
  if (magic(0)) {
    if (!magic(bytes.length - 6) || bytes.length < 18) fail('truncated file footer.');
    const footerLength = input.u32(bytes.length - 10), footerStart = bytes.length - 10 - footerLength;
    if (footerStart < 8 || !footerLength) fail('invalid file footer size.');
    const footer = new Metadata(bytes.subarray(footerStart, bytes.length - 10)), root = footer.root();
    const footerSchema = footer.target(root, 1);
    if (footerSchema === undefined) fail('file has no schema.');
    schema(footer, footerSchema);
    // The engine follows footer block offsets. Check these exact messages,
    // rather than trusting a sequential scan that a crafted footer can bypass.
    for (const [field, type] of [[2, 2], [3, 3]]) {
      const blocks = footer.vector(root, field, 24, MAX_ROWS + MAX_COLUMNS);
      for (let index = 0; index < blocks.length; index++) {
        const block = blocks.start + index * 24;
        const offset = footer.integer(block, footerStart), length = footer.i32(block + 8);
        const bodyLength = footer.integer(block + 16, MAX_DOCUMENT_BYTES);
        if (offset < 8 || length < 0) fail('invalid file block offset or length.');
        const result = message(offset, footerStart, type);
        if (result.metadataLength !== length || result.bodyLength !== bodyLength)
          fail('file block lengths do not match its message.');
      }
    }
  } else {
    let offset = 0;
    while (offset < bytes.length) {
      const result = message(offset, bytes.length);
      offset = result.next;
      if (!result.type) {
        if (offset !== bytes.length) fail('unexpected trailing bytes after stream end.');
        break;
      }
    }
  }
  if (!schemaSeen) fail('no schema was found.');
  return stats;
}
