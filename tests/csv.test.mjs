import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const output = await build({
  entryPoints: ['shared/csv.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
});
const { parseCsv, toCsv, csvRecords } = await import(
  `data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`
);
test('CSV preserves Chinese, quoted commas, newlines, escaped quotes and empty fields', () => {
  assert.deepEqual(
    parseCsv('\uFEFF名称,内容,数量\r\n"项目,一","第一行\n第二行",2\r\n"带""引号",,0'),
    [
      ['名称', '内容', '数量'],
      ['项目,一', '第一行\n第二行', '2'],
      ['带"引号', '', '0'],
    ],
  );
  assert.deepEqual(parseCsv('a\tb\n1\t2'), [
    ['a', 'b'],
    ['1', '2'],
  ]);
});
test('CSV rejects malformed fields and neutralizes formula injection on export', () => {
  assert.throws(() => parseCsv('a\n"unfinished'), /Unclosed/);
  assert.throws(() => parseCsv('a\n"closed"extra'), /Unexpected/);
  assert.match(toCsv([['=HYPERLINK("https://example.com")', -10]]), /'=HYPERLINK/);
  assert.ok(toCsv([[-10]]).includes('"-10"'));
});

test('quoted commas and newlines do not change a TSV delimiter', () => {
  assert.deepEqual(parseCsv('"Name,\nlabel"\tValue\r\n"A,B"\t7'), [
    ['Name,\nlabel', 'Value'],
    ['A,B', '7'],
  ]);
  assert.deepEqual(parseCsv('Name,label\tValue\nA,B\t7', undefined, '\t'), [
    ['Name,label', 'Value'],
    ['A,B', '7'],
  ]);
  assert.throws(() => parseCsv('x,'.repeat(101)), /100 columns/);
});

test('analysis CSV keeps unsafe numeric identifiers exact and rejects surplus fields', () => {
  assert.deepEqual(csvRecords('Identifier,Value,Zero\n9007199254740993,1.5,00123'), [
    { Identifier: '9007199254740993', Value: 1.5, Zero: '00123' },
  ]);
  assert.deepEqual(csvRecords('Identifier\n123456789012345678901234567890'), [
    { Identifier: '123456789012345678901234567890' },
  ]);
  assert.deepEqual(csvRecords('Precise,Normal\n1.00000000000000001,1.25'), [
    { Precise: '1.00000000000000001', Normal: 1.25 },
  ]);
  assert.throws(() => csvRecords('A,B\n1,2,3'), /more columns/);
});
