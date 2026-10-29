// Deterministic demonstration data. These fixtures are not user measurements.
const round = value => Math.round(value * 100) / 100;
const stages = ['预处理', '贴装', '回流焊', '检测', '装配', '老化'];
const production = stages.flatMap((工序, stage) =>
  ['白班', '夜班'].map((班次, shift) => ({
    工序,
    班次,
    产量: 620 + stage * 57 + shift * 93,
    不良数: 5 + ((stage * 7 + shift * 3) % 21),
    '耗电(kWh)': round(62 + stage * 13 + shift * 7),
  })),
);
const trend = Array.from({ length: 48 }, (_, i) =>
  ['A 产线', 'B 产线', 'C 产线'].map((产线, line) => ({
    小时: `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`,
    产线,
    '温度(°C)': round(36 + line * 6 + Math.sin(i / 7 + line) * 7 + Math.cos(i / 3) * 1.1),
    '电流(A)': round(9 + line * 3 + Math.sin(i / 8 + line) * 3),
    '噪声(dB)': round(42 + line * 5 + Math.sin(i * 0.8 + line) * 6),
  })),
).flat();
const scatter = Array.from({ length: 280 }, (_, i) => {
  const series = i % 4,
    load = 10 + ((i * 17) % 89);
  return {
    系列: ['控制器', '传感器', '网关', '执行器'][series],
    '负载(%)': load,
    '延迟(ms)': round(4 + series * 6 + load * 0.17 + Math.sin(i * 2.4) * 6),
    '吞吐(MB/s)': round(25 + ((i * 29) % 140)),
  };
});
const curves = ['试样 A', '试样 B', '试样 C'].flatMap((试样, series) =>
  Array.from({ length: 80 }, (_, i) => ({
    试样,
    '位移(mm)': round(i / 8),
    '力(N)': round(Math.max(0, (1 - Math.exp(-i / 18)) * (64 + series * 17) + Math.sin(i / 8) * 5)),
  })),
);
const density = Array.from({ length: 768 }, (_, i) => {
  const cluster = Math.floor(i / 192),
    k = i % 192;
  const radius = Math.sqrt((k + 1) / 192);
  return {
    '振动 X': round([-2.5, 2.1, -1.7, 2.6][cluster] + Math.cos(k * 2.4) * radius * 0.9),
    '振动 Y': round([-1.8, -1.2, 2.3, 2.1][cluster] + Math.sin(k * 2.4) * radius * 0.75),
  };
});
const hierarchy = ['控制系统', '通信系统', '采集系统', '显示系统'].flatMap((系统, system) =>
  ['任务调度', '数据缓存', '协议解析', '状态监测', '诊断日志'].map((子模块, module) => ({
    系统,
    子模块,
    '内存(MB)': round(8 + ((system * 11 + module * 17) % 48)),
    'CPU(%)': round(2 + ((system * 7 + module * 11) % 33)),
  })),
);
const heatmap = Array.from({ length: 20 }, (_, band) =>
  Array.from({ length: 12 }, (_, channel) => ({
    频段: `${String(band + 1).padStart(2, '0')}`,
    通道: `CH ${String(channel + 1).padStart(2, '0')}`,
    '能量(dB)': round(
      -60 +
        Math.sin(band / 3) * 15 +
        Math.cos(channel / 3) * 11 +
        (Math.abs(band - 12) < 3 && channel > 6 ? 22 : 0),
    ),
  })),
).flat();
const prices = Array.from({ length: 36 }, (_, i) => {
  const open = 98 + i * 0.55 + Math.sin(i / 3) * 5;
  const close = open + Math.sin(i * 1.9) * 4 + 0.7;
  return {
    日期: `2026-${i < 20 ? '09' : '10'}-${String((i % 20) + 1).padStart(2, '0')}`,
    开盘: round(open),
    收盘: round(close),
    最高: round(Math.max(open, close) + 1.5 + (i % 3)),
    最低: round(Math.min(open, close) - 1.2 - (i % 2)),
    成交量: 1200 + i * 67,
  };
});
const seriesConfig = metric => ({
  group_by: ['小时'],
  split_by: ['产线'],
  columns: [metric],
  sort: [['小时', 'asc']],
  aggregates: { [metric]: 'avg' },
});
const financial = {
  group_by: ['日期'],
  columns: ['开盘', '收盘', '最高', '最低', '成交量'],
  sort: [['日期', 'asc']],
  aggregates: { 开盘: 'avg', 收盘: 'avg', 最高: 'avg', 最低: 'avg', 成交量: 'sum' },
};
export const galleryCases = [
  {
    id: 'datagrid',
    plugin: 'Datagrid',
    title: '多维透视与条件格式',
    note: '按工序与班次汇总产量、不良数和能耗',
    rows: production,
    config: {
      group_by: ['工序', '班次'],
      group_by_depth: 2,
      columns: ['产量', '不良数', '耗电(kWh)'],
      columns_config: {
        不良数: {
          bg_mode: 'gradient',
          bg_color: 'linear-gradient(to right, #ffffff 0%, #ef4444 100%)',
        },
      },
    },
  },
  {
    id: 'x-bar',
    plugin: 'X Bar',
    title: '横向条形图',
    note: '各工序能耗与班次分布',
    rows: production,
    config: { group_by: ['工序'], split_by: ['班次'], columns: ['耗电(kWh)'] },
  },
  {
    id: 'y-bar',
    plugin: 'Y Bar',
    title: '堆叠柱状图',
    note: '各工序两班产量比较',
    rows: production,
    config: { group_by: ['工序'], split_by: ['班次'], columns: ['产量'] },
  },
  {
    id: 'y-line',
    plugin: 'Y Line',
    title: '多系列折线图',
    note: '三条产线的 24 小时温度趋势',
    rows: trend,
    config: seriesConfig('温度(°C)'),
  },
  {
    id: 'y-scatter',
    plugin: 'Y Scatter',
    title: '分类散点图',
    note: '按采样时刻与产线比较噪声',
    rows: trend,
    config: seriesConfig('噪声(dB)'),
  },
  {
    id: 'y-area',
    plugin: 'Y Area',
    title: '堆叠面积图',
    note: '多条产线的电流变化与组成',
    rows: trend,
    config: seriesConfig('电流(A)'),
  },
  {
    id: 'xy-scatter',
    plugin: 'X/Y Scatter',
    title: '气泡散点图',
    note: '负载、延迟、设备系列与吞吐量四维比较',
    rows: scatter,
    config: {
      columns: ['负载(%)', '延迟(ms)', '系列', '吞吐(MB/s)'],
      plugin_config: { point_size_px: 9 },
    },
  },
  {
    id: 'xy-line',
    plugin: 'X/Y Line',
    title: '数值曲线图',
    note: '三组试样的位移与受力关系',
    rows: curves,
    config: {
      columns: ['位移(mm)', '力(N)'],
      split_by: ['试样'],
      sort: [['位移(mm)', 'asc']],
      plugin_config: { facet_mode: 'overlay' },
    },
  },
  {
    id: 'density',
    plugin: 'Density',
    title: '二维密度图',
    note: '768 个合成振动采样点的密集区域',
    rows: density,
    config: {
      columns: ['振动 X', '振动 Y'],
      plugin_config: {
        gradient_color_mode: 'density',
        gradient_radius_px: 45,
        gradient_intensity: 1.5,
        gradient_heat_max: 3,
      },
    },
  },
  {
    id: 'treemap',
    plugin: 'Treemap',
    title: '矩形树图',
    note: '系统与子模块的内存分配，颜色表示 CPU 使用率',
    rows: hierarchy,
    config: {
      group_by: ['系统', '子模块'],
      group_by_depth: 2,
      columns: ['内存(MB)', 'CPU(%)'],
      aggregates: { '内存(MB)': 'sum', 'CPU(%)': 'avg' },
    },
  },
  {
    id: 'sunburst',
    plugin: 'Sunburst',
    title: '旭日图',
    note: '两级系统结构与内存占比',
    rows: hierarchy,
    config: {
      group_by: ['系统', '子模块'],
      group_by_depth: 2,
      columns: ['内存(MB)'],
      aggregates: { '内存(MB)': 'sum' },
    },
  },
  {
    id: 'heatmap',
    plugin: 'Heatmap',
    title: '热力图',
    note: '20 个频段与 12 个通道的能量分布',
    rows: heatmap,
    config: {
      group_by: ['频段'],
      split_by: ['通道'],
      columns: ['能量(dB)'],
      sort: [['频段', 'asc']],
      aggregates: { '能量(dB)': 'avg' },
    },
  },
  {
    id: 'candlestick',
    plugin: 'Candlestick',
    title: '蜡烛图',
    note: '合成行情的开盘、收盘、最高与最低值',
    rows: prices,
    config: financial,
  },
  {
    id: 'ohlc',
    plugin: 'OHLC',
    title: 'OHLC 图',
    note: '相同合成行情的开高低收刻线表示',
    rows: prices,
    config: financial,
  },
].map(item => ({
  ...item,
  config: { plugin: item.plugin, title: item.title, settings: false, ...item.config },
}));

export const excludedPlugins = ['Map Scatter', 'Map Line', 'Map Density'];
