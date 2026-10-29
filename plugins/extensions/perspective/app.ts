import '@perspective-dev/viewer-datagrid';
import '@perspective-dev/viewer-charts';
import '@perspective-dev/viewer/themes/pro.css';
import '@perspective-dev/viewer/themes/pro-dark.css';
import './app.css';

import perspective, { type Client, type Table, type View } from '@perspective-dev/client';
import clientWasm from '@perspective-dev/client/dist/wasm/perspective-js.wasm';
import serverWasm from '@perspective-dev/server/dist/wasm/perspective-server.wasm';
import viewer, { type ViewerConfigUpdate, type WorkspaceConfigUpdate } from '@perspective-dev/viewer';
import viewerWasm from '@perspective-dev/viewer/dist/wasm/perspective-viewer.wasm';

import { toCsv } from '../../../shared/csv';
import { mountApp } from '../../../shared/ui';
import { boundedQueryResult, rowsSchema, type Scalar, validateData } from '../../../shared/contracts';
import { analysisPlugins, analysisSchema, analysisValue, type AnalysisTypes } from '../../../shared/analysis';
import { analysisApplySchema, analysisInspectSchema, analysisQuerySchema } from './app-protocol';
import { base64FromBytes, parseAnalysisInput, serializeAnalysisDocument, type AnalysisInput } from './data-input';
import { createNativeEditGuard, type NativeEditTable } from './native-edit';
import { activeAnalysisConfig, normalizeAnalysisWorkspace, patchAnalysisConfig, patchAnalysisWorkspace, type AnalysisConfig, type AnalysisData, type AnalysisLayout, type AnalysisWorkspace } from './workspace';

const bytes = (base64: string) => Uint8Array.from(atob(base64), c => c.charCodeAt(0)).buffer;
perspective.init_client(bytes(clientWasm));
perspective.init_server(bytes(serverWasm));
await viewer.init_client(bytes(viewerWasm));

async function importAnalysisFile(file: File) {
  const extension = file.name.split('.').pop()?.toLowerCase();
  const format = extension === 'jsonl' ? 'ndjson' : extension === 'feather' ? 'arrow' : extension;
  if (!['json', 'ndjson', 'csv', 'tsv', 'arrow'].includes(format ?? '')) throw new Error('Supported formats: CSV, TSV, JSON, NDJSON, Arrow.');
  if (file.size > 2 * 1024 * 1024) throw new Error('Analysis input exceeds 2 MiB.');
  const buffer = await file.arrayBuffer();
  if (format !== 'arrow') return parseAnalysisInput({ format: format as AnalysisInput['format'], text: new TextDecoder('utf-8', { fatal: true }).decode(buffer) });
  const worker = await perspective.worker();
  try { return await parseAnalysisInput({ format: 'arrow', blob: base64FromBytes(new Uint8Array(buffer)) }, worker.table.bind(worker)); }
  finally { await worker.terminate(); }
}

const copy = <T>(value: T): T => structuredClone(value);
function nativePanel(config: AnalysisConfig, table: string, theme: string) {
  return { ...Object.fromEntries(Object.entries(config).filter(([, value]) => value !== null)), table, theme };
}
function layoutFor(ids: string[], mode: string): AnalysisLayout | undefined {
  if (!ids.length) return undefined;
  const children: AnalysisLayout[] = ids.map(id => ({ type: 'tab-layout', tabs: [id] }));
  return ids.length === 1 || mode === 'tabs' ? { type: 'tab-layout', tabs: ids } : { type: 'split-layout', orientation: mode === 'vertical' ? 'vertical' : 'horizontal', sizes: ids.map(() => 1), children };
}

mountApp('Perspective', async (container, changed, app, _initialDocument, requestContext, runAction) => {
  container.classList.add('analysis-editor');
  const zh = () => app.getHostContext()?.locale?.startsWith('zh') ?? true;
  const text = (cn: string, en: string) => zh() ? cn : en;
  const controls = document.createElement('div');
  controls.className = 'analysis-controls';
  controls.setAttribute('role', 'toolbar');
  controls.setAttribute('aria-label', text('图表面板', 'Chart panels'));
  const panels = document.createElement('select');
  panels.dataset.analysisPanel = '';
  panels.setAttribute('aria-label', text('当前面板', 'Current panel'));
  const charts = document.createElement('select');
  charts.dataset.analysisChart = '';
  charts.setAttribute('aria-label', text('新图表类型', 'New chart type'));
  charts.append(...analysisPlugins.map(name => new Option(name, name)));
  const layouts = document.createElement('select');
  layouts.dataset.analysisLayout = '';
  layouts.setAttribute('aria-label', text('面板布局', 'Panel layout'));
  layouts.append(new Option(text('左右排列', 'Side by side'), 'horizontal'), new Option(text('上下排列', 'Stacked'), 'vertical'), new Option(text('标签页', 'Tabs'), 'tabs'));
  const feedback = document.createElement('span');
  feedback.className = 'analysis-feedback';
  feedback.setAttribute('role', 'status');
  const element = document.createElement('perspective-viewer');
  controls.append(panels, charts);
  container.append(controls, element, feedback);
  let worker: Client | undefined, table: Table | undefined, sourceView: View | undefined;
  let source: Record<string, Scalar>[] = [], sourceSchema: AnalysisTypes = {};
  let tableId = '', loading = false, applyingTheme = 0, disposed = false;
  let masterPanels = new Set<string>();
  let selection: unknown;
  const events = new AbortController();
  let nativeEditFeedback = '';
  const guardNativeEdit = createNativeEditGuard({
    schema: () => sourceSchema,
    signal: events.signal,
    invalid(column, type) {
      const expected = type === 'integer'
        ? text('−2147483648 到 2147483647 的整数', 'an integer from −2147483648 to 2147483647')
        : type === 'float' ? text('有限数值', 'a finite decimal number')
        : type === 'date' ? 'YYYY-MM-DD'
        : type === 'datetime' ? text('含时区的 ISO 日期时间，例如 2026-10-29T08:30:00Z', 'an ISO date-time with a timezone, for example 2026-10-29T08:30:00Z')
        : text('最多 32768 个字符的文本', 'text of at most 32768 characters');
      nativeEditFeedback = text(`“${column}”未写入：请输入${expected}。原值已保留。`, `“${column}” was not changed. Enter ${expected}. The original value was kept.`);
      feedback.textContent = nativeEditFeedback;
    },
    valid() {
      if (nativeEditFeedback && feedback.textContent === nativeEditFeedback) feedback.textContent = '';
      nativeEditFeedback = '';
    },
  });
  const hostTheme = () => document.documentElement.dataset.theme === 'dark' ? 'Pro Dark' : 'Pro Light';
  function assertOpen() { if (disposed) throw new Error('Analysis is closed.'); }
  async function refreshSource() {
    assertOpen();
    if (sourceView) source = rowsSchema.parse(await sourceView.to_json());
    return source;
  }
  async function workspace(): Promise<AnalysisWorkspace> {
    assertOpen();
    await element.flush();
    const saved = await element.saveWorkspace();
    if (Object.keys(saved.derived_tables ?? {}).length) throw new Error('Derived tables are not supported in this document.');
    return normalizeAnalysisWorkspace({
      version: saved.version,
      panels: Object.fromEntries(Object.entries(saved.panels).map(([id, config]) => {
        if (config?.table !== tableId) throw new Error('A panel is not bound to the local document.');
        const { table: _table, theme: _theme, ...value } = config!;
        return [id, value];
      })),
      layout: saved.layout,
      activePanel: element.getActivePanel() ?? null,
      settings: saved.active !== undefined,
      masters: saved.masters ?? [],
      global_filters: saved.global_filters ?? [],
      palette: saved.palette ?? {},
    }, source, sourceSchema);
  }
  async function snapshot(): Promise<AnalysisData & Record<string, unknown>> {
    await refreshSource();
    const current = await workspace();
    return { rows: copy(source), schema: copy(sourceSchema), config: activeAnalysisConfig({ rows: source, workspace: current }), workspace: current };
  }
  async function updateControls() {
    if (disposed || loading || !table) return;
    const saved = await element.saveWorkspace();
    if (disposed) return;
    // Datagrid plugins are viewer-owned light DOM children. Each exposes its
    // regular-table in an open shadow root; getMeta is its public cell API.
    // Attach inside that root because cell-to-cell focus events stay inside it.
    for (const plugin of element.querySelectorAll('perspective-viewer-datagrid')) {
      const table = plugin.shadowRoot?.querySelector<NativeEditTable>('regular-table');
      if (table) guardNativeEdit(table);
    }
    masterPanels = new Set(saved.masters ?? []);
    panels.replaceChildren(...Object.entries(saved.panels).map(([id, config]) => new Option(config?.title || `${config?.plugin ?? 'Datagrid'} · ${id}`, id)));
    panels.value = element.getActivePanel() ?? '';
    panels.disabled = !panels.options.length;
    for (const name of ['duplicate', 'close', 'master']) controls.querySelector<HTMLButtonElement>(`[data-analysis-action="${name}"]`)!.disabled = !panels.options.length;
    const master = controls.querySelector<HTMLButtonElement>('[data-analysis-action="master"]')!;
    master.setAttribute('aria-pressed', String(saved.masters?.includes(panels.value) ?? false));
    master.classList.toggle('selected', master.getAttribute('aria-pressed') === 'true');
  }
  function onChange() {
    if (!disposed && !loading && !applyingTheme) { changed(); void updateControls().catch(() => undefined); }
  }
  for (const name of ['perspective-config-update', 'perspective-layout-update', 'perspective-active-panel-update', 'perspective-global-filter-update']) element.addEventListener(name, onChange, { signal: events.signal });
  element.addEventListener('perspective-select', event => { if (!disposed) { selection = (event as CustomEvent).detail; requestContext?.(); } }, { signal: events.signal });
  element.addEventListener('perspective-click', event => { if (!disposed) { selection = (event as CustomEvent).detail; requestContext?.(); } }, { signal: events.signal });
  const guardLinkedFilter = (event: Event) => {
    if (disposed || loading) return;
    const detail = (event as CustomEvent).detail as { panel?: string; config?: { filter?: unknown[][] }; insertConfigs?: { filter?: unknown[][] }[]; removeConfigs?: { filter?: unknown[][] }[] } | undefined;
    if (!detail || !masterPanels.has(detail.panel ?? element.getActivePanel())) return;
    const filters = [...(detail.config?.filter ?? []), ...(detail.insertConfigs ?? []).flatMap(config => config.filter ?? []), ...(detail.removeConfigs ?? []).flatMap(config => config.filter ?? [])];
    if (filters.some(filter => typeof filter[0] !== 'string' || !Object.hasOwn(sourceSchema, filter[0]))) {
      // A private expression alias has no equivalent in another panel. Do not
      // let the native overlay turn it into an unsavable workspace.
      event.stopImmediatePropagation();
      event.preventDefault();
      feedback.textContent = text('点击联动仅支持源数据列；计算列仍可在当前图表中使用。', 'Linked clicks require source columns; computed columns remain available in this chart.');
    }
  };
  element.addEventListener('perspective-click', guardLinkedFilter, { capture: true, signal: events.signal });
  element.addEventListener('perspective-global-filter', guardLinkedFilter, { capture: true, signal: events.signal });
  // The native panel menu also creates table bindings outside this document's
  // single-source contract. Local panel operations are provided above instead.
  element.addEventListener('contextmenu', event => {
    event.stopImmediatePropagation();
    const editing = event.composedPath().some(target => target instanceof HTMLElement && (target.matches('input,textarea') || target.isContentEditable));
    if (!editing && !event.shiftKey) event.preventDefault();
  }, { capture: true, signal: events.signal });
  const theme = new MutationObserver(() => {
    if (!table || disposed) return;
    applyingTheme++;
    void (async () => {
      for (const panel of element.getPanelNames()) { assertOpen(); await element.restore({ theme: hostTheme() }, { panel }); }
    })().catch(() => undefined).finally(() => { applyingTheme--; });
  });
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  async function query(raw: Record<string, unknown>) {
    const { panelId, ...window } = analysisQuerySchema.parse(raw);
    if (!table || !element.getPanelNames().length) {
      if (panelId) throw new Error(`Unknown analysis panel: ${panelId}`);
      return { totalRows: 0, totalColumns: 0, ...window, rows: [] };
    }
    const panel = panelId ?? element.getActivePanel();
    if (!element.getPanelNames().includes(panel)) throw new Error(`Unknown analysis panel: ${panel}`);
    await element.flush();
    const view: View = await element.getView({ panel, mode: 'clone' });
    try {
      const [totalRows, totalColumns, rows] = await Promise.all([view.num_rows(), view.num_columns(), view.to_json({ start_row: window.offset, end_row: window.offset + window.limit, start_col: window.columnOffset, end_col: window.columnOffset + window.columnLimit })]);
      return boundedQueryResult({ panelId: panel, totalRows, totalColumns, ...window, rows, hasMoreRows: window.offset + rows.length < totalRows, hasMoreColumns: window.columnOffset + window.columnLimit < totalColumns });
    } finally { await view.delete(); }
  }
  async function preflight(data: AnalysisData) {
    // Both live changes and persistent writes use the same bounded local
    // engine/style validator. This operation never creates or saves a document.
    const response = await app.callServerTool({ name: 'inspect_analysis', arguments: { data, section: 'configuration', limit: 1 } });
    if (response.isError || !response.structuredContent) throw new Error(response.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') || 'Invalid analysis.');
  }
  async function restoreWorkspace(current: AnalysisWorkspace) {
    const { activePanel, settings, ...state } = current;
    await element.restoreWorkspace({ ...state, layout: state.layout ?? undefined, panels: Object.fromEntries(Object.entries(state.panels).map(([id, config]) => [id, nativePanel(config, tableId, hostTheme())])) } as WorkspaceConfigUpdate);
    if (activePanel) await element.setActivePanel(activePanel);
    await element.toggleConfig(settings ?? true);
    await element.flush();
  }
  async function apply(raw: Record<string, unknown>, unchanged: () => boolean, incremental = false) {
    assertOpen();
    if (!table || !worker) throw new Error('Import data before configuring the analysis.');
    const patch = analysisApplySchema.parse(raw);
    const before = await snapshot();
    let next = copy(before);
    const changingData = patch.rows !== undefined || patch.cells !== undefined || patch.append !== undefined;
    if (patch.rows) next.rows = copy(patch.rows);
    for (const cell of patch.cells ?? []) {
      if (cell.row >= next.rows.length || !Object.hasOwn(sourceSchema, cell.column)) throw new Error('Cell is outside the source table.');
      next.rows[cell.row][cell.column] = cell.value;
    }
    if (patch.append) next.rows.push(...copy(patch.append));
    if (next.rows.some(row => Object.keys(row).some(name => !Object.hasOwn(sourceSchema, name)))) throw new Error('Live source edits must use existing columns. Import a document to change the schema.');
    if (patch.workspace) next = patchAnalysisWorkspace(next, patch.workspace);
    if (patch.config) next = patchAnalysisConfig(next, patch.config, patch.panelId);
    next = validateData('perspective', next) as typeof next;
    await preflight(next);
    if (disposed || !unchanged()) throw new Error('CONFLICT: Analysis changed before applying.');
    const resetLinkedSelection = patch.workspace?.global_filters?.length === 0 &&
      (!patch.workspace.panels || incremental);
    loading = true;
    try {
      if (changingData) await table.replace(next.rows.map(row => Object.fromEntries(Object.keys(sourceSchema).map(name => [name, analysisValue(row, name)]))));
      // Replacing an empty overlay alone leaves native click-toggle state set.
      // Reset roles through the public API so the same item can be selected again.
      if (resetLinkedSelection) await element.restoreWorkspace({ masters: [], global_filters: [] });
      if (patch.workspace?.panels && incremental) {
        const previous = before.workspace!.panels, current = next.workspace!;
        for (const id of Object.keys(previous)) {
          assertOpen();
          if (!Object.hasOwn(current.panels, id)) await element.removePanel(id);
        }
        for (const [id, config] of Object.entries(current.panels)) {
          assertOpen();
          if (!Object.hasOwn(previous, id)) await element.restore(nativePanel(config, tableId, hostTheme()) as ViewerConfigUpdate, { panel: id });
        }
        const { panels: _panels, activePanel, settings, version: _version, ...state } = patch.workspace;
        await element.restoreWorkspace({ ...state, layout: state.layout ?? undefined } as WorkspaceConfigUpdate);
        if (activePanel) await element.setActivePanel(activePanel);
        if (settings !== undefined) await element.toggleConfig(settings);
      }
      else if (patch.workspace?.panels) await restoreWorkspace(next.workspace!);
      else {
        if (patch.config) await element.restore(activeAnalysisConfig(next, patch.panelId) as ViewerConfigUpdate, { panel: patch.panelId ?? next.workspace!.activePanel ?? undefined });
        if (patch.workspace) {
          const { activePanel, settings, panels: _panels, version: _version, ...state } = patch.workspace;
          await element.restoreWorkspace({ ...state, layout: state.layout ?? undefined } as WorkspaceConfigUpdate);
          if (activePanel) await element.setActivePanel(activePanel);
          if (settings !== undefined) await element.toggleConfig(settings);
        }
      }
      if (resetLinkedSelection) await element.restoreWorkspace({ masters: next.workspace!.masters ?? [] });
      if (patch.config?.settings !== undefined) await element.toggleConfig(next.workspace!.settings);
      await element.flush();
    } catch (error) {
      if (changingData) await table.replace(before.rows);
      await restoreWorkspace(before.workspace!);
      throw error;
    } finally { loading = false; }
    await refreshSource();
    await updateControls();
  }
  function action(name: string, cn: string, en: string, operation: () => Promise<void>) {
    const button = document.createElement('button');
    button.dataset.analysisAction = name;
    button.textContent = text(cn, en);
    button.title = button.textContent;
    button.addEventListener('click', () => void manual(operation));
    controls.append(button);
  }
  async function manual(operation: () => Promise<void>) {
    if (!runAction) return;
    await runAction(async () => {
      assertOpen();
      feedback.textContent = '';
      await operation();
      changed();
      await updateControls();
    });
  }
  function defaultConfig(plugin: string): AnalysisConfig {
    const numeric = Object.keys(sourceSchema).filter(name => ['float', 'integer'].includes(sourceSchema[name]));
    const category = Object.keys(sourceSchema).find(name => sourceSchema[name] === 'string');
    const columns = plugin === 'Datagrid' ? Object.keys(sourceSchema) : ['X/Y Scatter', 'X/Y Line', 'Density'].includes(plugin) ? numeric.slice(0, 2) : ['Candlestick', 'OHLC'].includes(plugin) ? numeric.slice(0, 4) : numeric.slice(0, 1);
    return { plugin: plugin as AnalysisConfig['plugin'], columns, ...(category && !['Datagrid', 'X/Y Scatter', 'X/Y Line', 'Density'].includes(plugin) ? { group_by: [category] } : {}) };
  }
  action('add', '新增图表', 'Add chart', async () => {
    const data = await snapshot(), id = `panel-${crypto.randomUUID()}`;
    const nextPanels = { ...data.workspace!.panels, [id]: defaultConfig(charts.value) };
    await apply({ workspace: { panels: nextPanels, activePanel: id, layout: layoutFor(Object.keys(nextPanels), layouts.value) } }, () => !disposed, true);
  });
  action('duplicate', '复制', 'Duplicate', async () => {
    const data = await snapshot(), id = `panel-${crypto.randomUUID()}`;
    const nextPanels = { ...data.workspace!.panels, [id]: copy(activeAnalysisConfig(data)) };
    await apply({ workspace: { panels: nextPanels, activePanel: id, layout: layoutFor(Object.keys(nextPanels), layouts.value) } }, () => !disposed, true);
  });
  action('close', '关闭图表', 'Close chart', async () => {
    const data = await snapshot(), id = data.workspace!.activePanel!;
    const nextPanels = { ...data.workspace!.panels };
    delete nextPanels[id];
    const role = data.workspace!.masters?.includes(id)
      ? { masters: data.workspace!.masters.filter(master => master !== id), global_filters: [] }
      : {};
    await apply({ workspace: { panels: nextPanels, activePanel: Object.keys(nextPanels)[0] ?? null, ...role, layout: layoutFor(Object.keys(nextPanels), layouts.value) ?? null } }, () => !disposed, true);
  });
  action('master', '点击联动', 'Link clicks', async () => {
    const data = await snapshot(), id = data.workspace!.activePanel!;
    const masters = new Set(data.workspace!.masters ?? []);
    if (masters.has(id)) masters.delete(id); else masters.add(id);
    await apply({ workspace: { masters: [...masters], global_filters: [] } }, () => !disposed);
  });
  action('clear-filters', '清除联动', 'Clear linked filters', () => apply({ workspace: { global_filters: [] } }, () => !disposed));
  controls.append(layouts);
  panels.addEventListener('change', () => void manual(() => apply({ workspace: { activePanel: panels.value } }, () => !disposed)));
  layouts.addEventListener('change', () => void manual(async () => { const ids = element.getPanelNames() as string[]; if (ids.length) await apply({ workspace: { layout: layoutFor(ids, layouts.value) } }, () => !disposed); }));

  async function exportFile(format = 'csv') {
    const data = await snapshot();
    if (format === 'analysis') return { text: serializeAnalysisDocument(data), extension: 'json', mimeType: 'application/json' };
    const panel = element.getActivePanel() as string | null;
    if (!table || !panel) throw new Error('Select a chart before exporting.');
    const view: View = await element.getView({ panel, mode: 'clone' });
    try {
      const totalRows = await view.num_rows(), totalColumns = await view.num_columns();
      if (totalRows > 20000 || totalColumns > 200 || totalRows * totalColumns > 500000) throw new Error('The pivot result is too large to export. Reduce the view first.');
      if (format === 'png') {
        const config = activeAnalysisConfig(data, panel);
        if (!config.plugin || config.plugin === 'Datagrid') throw new Error('Choose a chart to export PNG.');
        // Native chart export redraws and dismisses pinned master selections.
        // Render a private instance against the same authorized local table.
        const temporary = document.createElement('perspective-viewer');
        const bounds = element.getBoundingClientRect();
        temporary.className = 'analysis-export-viewer';
        temporary.style.width = `${Math.min(2400, Math.max(640, bounds.width))}px`;
        temporary.style.height = `${Math.min(1600, Math.max(480, bounds.height))}px`;
        document.body.append(temporary);
        temporary.setAutoPause(false);
        try {
          await temporary.load(worker!);
          await temporary.restore({ ...nativePanel(config, tableId, hostTheme()), ...(await view.get_config()), settings: false } as ViewerConfigUpdate);
          if (data.workspace?.palette) await temporary.restoreWorkspace({ palette: data.workspace.palette });
          await temporary.flush();
          const output = await temporary.export({ method: 'plugin' }) as Blob;
          if (!(output instanceof Blob) || output.type !== 'image/png') throw new Error('The renderer did not produce a PNG.');
          return { blob: base64FromBytes(new Uint8Array(await output.arrayBuffer())), extension: 'png', mimeType: 'image/png' };
        } finally { try { await temporary.delete(); } finally { temporary.remove(); } }
      }
      if (format === 'arrow') {
        const output = await view.to_arrow();
        return { blob: base64FromBytes(new Uint8Array(output)), extension: 'arrow', mimeType: 'application/vnd.apache.arrow.file' };
      }
      const rows = await view.to_json() as Record<string, unknown>[];
      const columns = Array.from(new Set(rows.flatMap(row => Object.keys(row))));
      let output: { text: string; extension: string; mimeType: string };
      if (format === 'json') output = { text: JSON.stringify(rows, null, 2), extension: 'json', mimeType: 'application/json' };
      else if (format === 'ndjson') output = { text: rows.map(row => JSON.stringify(row)).join('\n'), extension: 'ndjson', mimeType: 'application/x-ndjson' };
      else if (format === 'html') {
        const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
        output = { text: `<!doctype html><meta charset="utf-8"><title>Analysis</title><table><thead><tr>${columns.map(name => `<th>${escape(name)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${columns.map(name => `<td>${escape(typeof row[name] === 'object' ? JSON.stringify(row[name]) : row[name])}</td>`).join('')}</tr>`).join('')}</tbody></table>`, extension: 'html', mimeType: 'text/html' };
      } else output = { text: toCsv([columns, ...rows.map(row => columns.map(key => row[key]))]), extension: 'csv', mimeType: 'text/csv' };
      if (new TextEncoder().encode(output.text).byteLength > 8 * 1024 * 1024) throw new Error('Export exceeds 8 MiB. Reduce the view first.');
      return output;
    } finally { await view.delete(); }
  }
  return {
    async load(document) {
      loading = true;
      source = rowsSchema.parse(document.data.rows);
      sourceSchema = analysisSchema(source, document.data.schema);
      tableId = document.id;
      const data = document.data as unknown as AnalysisData;
      if (!Object.keys(sourceSchema).length) {
        controls.hidden = true;
        element.hidden = true;
        feedback.textContent = text('导入数据开始分析', 'Import data to start');
        loading = false;
        return;
      }
      worker = await perspective.worker();
      if (disposed) { await worker.terminate(); throw new Error('Analysis load was cancelled.'); }
      table = await worker.table(sourceSchema, { name: tableId });
      await table.update(source.map(row => Object.fromEntries(Object.keys(sourceSchema).map(name => [name, analysisValue(row, name)]))));
      sourceView = await table.view({});
      await sourceView.on_update(() => { if (!disposed && !loading) changed(); });
      await element.load(worker);
      const current = data.workspace ?? normalizeAnalysisWorkspace({ panels: { main: data.config ?? {} }, activePanel: 'main', settings: data.config?.settings ?? true }, source, sourceSchema);
      await restoreWorkspace(current);
      loading = false;
      await updateControls();
    },
    async snapshot() {
      if (!table) return { rows: source, schema: sourceSchema, config: {} };
      return snapshot();
    },
    async describe() {
      if (!table) return { rowCount: 0, schema: sourceSchema, config: {}, activePanelId: null, panels: [], preview: { rows: [] } };
      const data = await snapshot();
      return { rowCount: source.length, schema: sourceSchema, selection, config: data.config, workspace: data.workspace, activePanelId: data.workspace!.activePanel, panels: Object.entries(data.workspace!.panels).map(([id, config]) => ({ id, title: config.title, plugin: config.plugin, master: data.workspace!.masters?.includes(id) ?? false })), preview: await query({ limit: 10, columnLimit: 10 }) };
    },
    query,
    async inspect(raw) {
      const input = analysisInspectSchema.parse(raw), data = table ? await snapshot() : { rows: source, schema: sourceSchema, config: {} };
      if (input.kind === 'workspace') return { workspace: data.workspace, activePanelId: data.workspace?.activePanel ?? null };
      if (input.kind === 'source') return { schema: sourceSchema, totalRows: source.length, offset: input.offset, rows: copy(source.slice(input.offset, input.offset + input.limit)), hasMoreRows: input.offset + input.limit < source.length };
      if (input.kind === 'selection') return { panelId: input.panelId ?? element.getActivePanel(), selection, window: table && element.getPanelNames().length ? await element.getSelection({ panel: input.panelId }) : null };
      const response = await app.callServerTool({ name: input.kind === 'plugins' ? 'list_visualizations' : 'inspect_analysis', arguments: input.kind === 'plugins' ? {} : { data, section: input.section, limit: Math.min(20, input.limit), ...(input.search ? { search: input.search } : {}), ...(input.panelId ? { panelId: input.panelId } : {}), ...(input.plugin ? { plugin: input.plugin } : {}), ...(input.column ? { column: input.column } : {}) } });
      if (response.isError || !response.structuredContent) throw new Error(response.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') || 'Inspection failed.');
      return response.structuredContent as Record<string, unknown>;
    },
    apply,
    exportFile,
    async dispose() {
      if (disposed) return;
      disposed = true;
      events.abort();
      theme.disconnect();
      try { await element.delete(); } finally {
        try { await sourceView?.delete(); } finally {
          try { await table?.delete(); } finally { await worker?.terminate(); }
        }
      }
    },
  };
}, {
  kind: 'perspective', importFile: importAnalysisFile,
  applySchema: analysisApplySchema, querySchema: analysisQuerySchema, inspectSchema: analysisInspectSchema,
  accept: '.csv,.tsv,.json,.ndjson,.jsonl,.arrow,.feather',
  exportFormats: [
    { value: 'csv', zh: 'CSV 数据', en: 'CSV data' },
    { value: 'png', zh: 'PNG 图表', en: 'PNG chart' },
    { value: 'json', zh: 'JSON 数据', en: 'JSON data' },
    { value: 'ndjson', zh: 'NDJSON 数据', en: 'NDJSON data' },
    { value: 'arrow', zh: 'Arrow 数据', en: 'Arrow data' },
    { value: 'html', zh: 'HTML 表格', en: 'HTML table' },
    { value: 'analysis', zh: '完整分析文档', en: 'Full analysis document' },
  ],
});
