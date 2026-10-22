import datagridPlugin from '@perspective-dev/viewer-datagrid/src/ts/plugin/plugin_config_schema.ts';
import datagridColumn from '@perspective-dev/viewer-datagrid/src/ts/plugin/column_config_schema.ts';
import { HTMLPerspectiveViewerWebGLPluginElement as ChartsPlugin } from '@perspective-dev/viewer-charts/src/ts/plugin/plugin.ts';
import charts from '@perspective-dev/viewer-charts/src/ts/plugin/charts.ts';
import { DEFAULT_PLUGIN_CONFIG } from '@perspective-dev/viewer-charts/src/ts/charts/chart.ts';
import { validateStyleFields } from '../../../shared/style-validation';

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
