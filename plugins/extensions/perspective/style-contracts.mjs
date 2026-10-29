import datagridPlugin from '@perspective-dev/viewer-datagrid/src/ts/plugin/plugin_config_schema.ts';
import datagridColumn from '@perspective-dev/viewer-datagrid/src/ts/plugin/column_config_schema.ts';
import { HTMLPerspectiveViewerWebGLPluginElement as ChartsPlugin } from '@perspective-dev/viewer-charts/src/ts/plugin/plugin.ts';
import charts from '@perspective-dev/viewer-charts/src/ts/plugin/charts.ts';
import { DEFAULT_PLUGIN_CONFIG } from '@perspective-dev/viewer-charts/src/ts/charts/chart.ts';
import { validateStyleFields } from '../../../shared/style-validation';
import { analysisPlugins } from '../../../shared/analysis';
import documentation from '@perspective-dev/viewer/dist/docs/perspective-docs.json';

// Theme defaults only fill schema hints. Validation never creates a DOM,
// renderer, network client or browser, and never changes the engine's globals.
const grid = {
  model: {
    _pos_fg_color: ['#00ff00'],
    _neg_fg_color: ['#ff0000'],
    _pos_bg_color: ['#00ff00'],
    _neg_bg_color: ['#ff0000'],
    _plugin_background: [255, 255, 255],
    _color: ['#000000'],
    _series_palette: ['#ff0000', '#00ff00'],
  },
};
const chartSelf = chart => ({
  _chartType: chart,
  _effectiveDefaults: () => ({ ...DEFAULT_PLUGIN_CONFIG, ...chart.plugin_field_defaults }),
  _themeGradientStopsSpec: () => 'linear-gradient(to right, #ff0000 0%, #00ff00 100%)',
  _themeSeriesPaletteHex: () => 'linear-gradient(to right, #ff0000, #00ff00)',
  _themeSeriesColorHex: () => '#ff0000',
});
const proto = ChartsPlugin.prototype;
const chartPluginFields = charts.flatMap(
  chart => proto.plugin_config_schema.call(chartSelf(chart), {}).fields,
);
const allPluginFields = [
  ...chartPluginFields,
  ...datagridPlugin.call(grid, {}, { zebra_rows: 1 }).fields,
  { kind: 'Bool', key: 'editable' },
];
const columnFields = new Map();
function allColumnFields(type) {
  if (columnFields.has(type)) return columnFields.get(type);
  const fields = [],
    name = 'column';
  const config = { columns: [name], group_by: [name], split_by: [] };
  for (const fg_mode of ['color', 'bar', 'label-bar', 'disabled', 'series'])
    for (const bg_mode of ['color', 'gradient', 'pulse', 'disabled', 'series'])
      fields.push(
        ...datagridColumn.call(
          grid,
          type,
          undefined,
          name,
          { fg_mode, bg_mode },
          config,
          {},
          'column',
        ).fields,
      );
  for (const chart of charts)
    for (const chart_type of ['bar', 'line', 'scatter', 'area'])
      for (const group of [undefined, 'Color', ...chart.initial.names])
        fields.push(
          ...proto.column_config_schema.call(
            chartSelf(chart),
            type,
            group,
            name,
            { chart_type },
            config,
            {},
            'column',
          ).fields,
        );
  columnFields.set(type, fields);
  return fields;
}

export function validateStyles(config, types) {
  const pluginConfig = config.plugin_config ?? {};
  const chart =
    config.plugin && config.plugin !== 'Datagrid'
      ? charts.find(item => item.name === config.plugin)
      : undefined;
  const self = chart ? chartSelf(chart) : grid;
  const fields = chart
    ? chartPluginFields
    : datagridPlugin.call(grid, config, { ...pluginConfig, zebra_rows: 1 }).fields;
  // editable is the upstream legacy alias, which its current controls omit.
  validateStyleFields(pluginConfig, { fields }, true);
  validateStyleFields(pluginConfig, { fields: allPluginFields });
  for (const [name, value] of Object.entries(config.columns_config ?? {})) {
    if (!Object.hasOwn(types, name)) throw new Error(`Unknown styled analysis column: ${name}`);
    const type = types[name];
    const role =
      !config.columns || config.columns.includes(name)
        ? 'column'
        : config.split_by?.includes(name)
          ? 'split_by'
          : config.group_by?.includes(name)
            ? 'group_by'
            : 'column';
    const slot = config.columns?.indexOf(name) ?? -1;
    const group = chart?.initial.names[slot];
    const active = chart
      ? proto.column_config_schema.call(self, type, group, name, value, config, pluginConfig, role)
      : datagridColumn.call(grid, type, undefined, name, value, config, pluginConfig, role);
    validateStyleFields(value, active, true);
    // Upstream retains foreign/hidden style keys when changing plugins. Check
    // those against the union too, without discarding the preserved settings.
    validateStyleFields(value, { fields: allColumnFields(type) });
  }
}

/** Labels and slots come from the same public registry as the viewer. */
export function listAnalysisVisualizations() {
  return analysisPlugins.map(name => {
    const chart = charts.find(item => item.name === name);
    return chart ? {
      name,
      category: chart.category,
      columns: { initialCount: chart.initial.count, roles: chart.initial.names },
      groupByRole: chart.group_by_role ?? 'Aggregation keys',
      splitByRole: chart.split_by_role ?? 'Series',
      connectsRowOrder: chart.connects_row_order ?? false,
    } : {
      name,
      category: 'Grid',
      columns: { initialCount: 0, roles: ['Columns'] },
      groupByRole: 'Row groups',
      splitByRole: 'Column groups',
      connectsRowOrder: false,
    };
  });
}

export function inspectAnalysisStyles(config, types, column) {
  const chart = charts.find(item => item.name === config.plugin);
  const self = chart ? chartSelf(chart) : grid;
  const pluginConfig = config.plugin_config ?? {};
  const plugin = chart
    ? proto.plugin_config_schema.call(self, config, pluginConfig)
    : datagridPlugin.call(grid, config, { ...pluginConfig, zebra_rows: 1 });
  let selected;
  if (column !== undefined) {
    if (!Object.hasOwn(types, column)) throw new Error(`Unknown styled analysis column: ${column}`);
    const role = !config.columns || config.columns.includes(column) ? 'column'
      : config.split_by?.includes(column) ? 'split_by'
        : config.group_by?.includes(column) ? 'group_by' : 'column';
    const group = chart?.initial.names[config.columns?.indexOf(column) ?? -1];
    selected = chart
      ? proto.column_config_schema.call(self, types[column], group, column,
        config.columns_config?.[column] ?? {}, config, pluginConfig, role)
      : datagridColumn.call(grid, types[column], undefined, column,
        config.columns_config?.[column] ?? {}, config, pluginConfig, role);
  }
  return {
    plugin: config.plugin ?? 'Datagrid',
    pluginSchema: plugin,
    ...(selected ? { column, columnSchema: selected } : {}),
    themeDefaults: 'Schema hints use local defaults; the live viewer supplies its active theme values.',
  };
}

/** Version-matched help comes from the public package, never a network request. */
export function analysisReference(section, search = '', limit = 8) {
  const names = section === 'windows'
    ? ['Windows', 'WindowSpec', 'WindowSort', 'WindowSortDir', 'Aggregate']
    : section === 'expressions' ? ['Expressions']
      : ['Filter', 'FilterTerm', 'FilterReducer', 'Aggregate'];
  const definitions = documentation.schemas.ViewerConfigUpdate.definitions ?? {};
  const schema = Object.fromEntries(names.filter(name => Object.hasOwn(definitions, name))
    .map(name => [name, definitions[name]]));
  const needle = search.toLowerCase();
  const category = section === 'configuration' ? /config|filter|aggregate|sort/i
    : section === 'windows' ? /window/i : /expression|exprtk/i;
  const matches = documentation.chunks.filter(chunk => category.test(`${chunk.title} ${chunk.path}`)
    && (!needle || `${chunk.title} ${chunk.path} ${chunk.text}`.toLowerCase().includes(needle)));
  return {
    schema,
    entries: matches.slice(0, limit).map(chunk => ({ title: chunk.title, path: chunk.path,
      text: chunk.text.slice(0, 3000), truncated: chunk.text.length > 3000 })),
    totalEntries: matches.length,
    hasMore: matches.length > limit,
    source: '@perspective-dev/viewer/dist/docs/perspective-docs.json',
  };
}
