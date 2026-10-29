import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const bundle = await build({ stdin: { contents: `export * from './plugins/extensions/perspective/workspace'; export * from './shared/contracts'; export * from './shared/live-app';`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', write: false });
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const rows = [{ region: 'East', amount: 7 }, { region: 'West', amount: 5 }];
const panels = { summary: { plugin: 'Y Bar', group_by: ['region'], columns: ['amount'] }, detail: { plugin: 'Datagrid', columns: ['region', 'amount'] } };

test('workspace targets stable panel IDs and derives the compatibility config from its active panel', () => {
  const data = api.validateData('perspective', { rows, config: { plugin: 'OHLC' }, workspace: { panels, activePanel: 'detail', masters: ['summary'] } });
  assert.equal(data.config.plugin, 'Datagrid');
  const next = api.patchAnalysisConfig(data, { sort: [['amount', 'desc']] }, 'summary');
  assert.deepEqual(next.workspace.panels.summary.sort, [['amount', 'desc']]);
  assert.equal(next.config.plugin, 'Datagrid');
  assert.equal(data.workspace.panels.summary.sort, undefined);
  assert.equal(api.patchAnalysisConfig(data, { settings: false }).workspace.settings, false);
  assert.throws(() => api.patchAnalysisConfig(data, {}, 'unknown'), /Unknown analysis panel/);
  assert.deepEqual(api.activeAnalysisConfig({ rows, workspace: { panels: {} } }), {});
  assert.throws(() => api.activeAnalysisConfig({ rows, workspace: { panels: {} } }, 'summary'), /Unknown analysis panel/);
});

test('workspace validates layout and all references before any persistence or native restore', () => {
  const normalize = workspace => api.normalizeAnalysisWorkspace({ panels, ...workspace }, rows);
  const split = { type: 'split-layout', orientation: 'horizontal', sizes: [1, 2], children: [{ type: 'tab-layout', tabs: ['summary'] }, { type: 'tab-layout', tabs: ['detail'] }] };
  assert.deepEqual(normalize({ layout: split }).layout, split);
  assert.deepEqual(normalize({ layout: { type: 'split-layout', orientation: 'horizontal', sizes: [1], children: [{ type: 'tab-layout', tabs: ['summary', 'detail'] }] } }).layout, { type: 'tab-layout', tabs: ['summary', 'detail'] });
  assert.throws(() => normalize({ layout: { ...split, sizes: [1] } }), /sizes/);
  assert.throws(() => normalize({ layout: { type: 'tab-layout', tabs: ['summary', 'summary'] } }), /repeated/);
  assert.throws(() => normalize({ layout: { type: 'tab-layout', tabs: ['summary'] } }), /every panel/);
  assert.throws(() => normalize({ layout: { type: 'tab-layout', tabs: ['summary', 'detail'], selected: 2 } }), /selected/);
  assert.throws(() => normalize({ masters: ['missing'] }), /masters/);
  assert.throws(() => normalize({ global_filters: [['unknown', '==', 'x']] }), /Unknown analysis column/);
  assert.throws(() => normalize({ panels: { ...panels, foreign: { table: 'file:///private', plugin: 'Datagrid' } } }), /table/);
  assert.throws(() => normalize({ derived_tables: { local: {} } }), /derived_tables/);
  assert.throws(() => normalize({ panels: Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`panel-${index}`, {}])) }), /8 panels/);
  assert.deepEqual(api.normalizeAnalysisWorkspace({ panels: {}, layout: null }, rows).activePanel, null);
  assert.equal(api.normalizeAnalysisWorkspace({ panels: {}, layout: { type: 'split-layout', orientation: 'horizontal', children: [], sizes: [] } }, rows).layout, null);
});

test('workspace palette accepts local colors while rejecting remote resource injection', () => {
  const normalize = palette => api.normalizeAnalysisWorkspace({ panels, palette }, rows);
  assert.equal(normalize({ '--psp-user--color-brand': '#336699' }).palette['--psp-user--color-brand'], '#336699');
  assert.throws(() => normalize({ '--psp-user--color-brand': 'url(https://example.com/x)' }));
  assert.throws(() => normalize({ '--arbitrary-css': 'red' }));
});

test('large live context retains the exact active panel identifier', () => {
  const result = JSON.parse(api.contextText({ documentId: 'document', activePanelId: 'detail', workspace: { panels: Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`key${index}`, 'x'.repeat(240)])) }, panels: Array.from({ length: 500 }, (_, index) => ({ id: index, title: 'x'.repeat(240) })) }));
  assert.equal(result.activePanelId, 'detail');
  assert.equal(result.previewOmitted, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 16000);
});
