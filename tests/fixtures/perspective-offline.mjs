// Synthetic records cover source types without relying on locale inference.
export const offlineRows = [
  { 编号: '001', 区域: '华东', 数量: 12, 金额: 180.5, 营业日: '2026-10-01', 更新时间: '2026-10-01T08:30:00+08:00', 启用: true },
  { 编号: '002', 区域: '华南', 数量: 7, 金额: 245, 营业日: '2026-10-02', 更新时间: '2026-10-02T09:15:00Z', 启用: true },
  { 编号: '003', 区域: '华东', 数量: 8, 金额: 120, 营业日: '2026-10-03', 更新时间: '2026-10-03T10:45:00+08:00', 启用: false },
  { 编号: '004', 区域: '华北', 数量: 10, 金额: 450.25, 营业日: '2026-10-04', 更新时间: '2026-10-04T11:00:00Z', 启用: true },
  { 编号: '005', 区域: '华南', 数量: 3, 金额: 105, 营业日: '2026-10-05', 更新时间: '2026-10-05T12:30:00+08:00', 启用: false },
  { 编号: '006', 区域: '华东', 数量: 5, 金额: 87.5, 营业日: '2026-10-06', 更新时间: '2026-10-06T13:30:00Z', 启用: true },
];

export const offlineSchema = {
  编号: 'string',
  区域: 'string',
  数量: 'integer',
  金额: 'float',
  营业日: 'date',
  更新时间: 'datetime',
  启用: 'boolean',
};

export const normalizedOfflineRows = offlineRows.map(row => ({
  ...row,
  营业日: Date.parse(`${row.营业日}T00:00:00.000Z`),
  更新时间: Date.parse(row.更新时间),
}));

export const offlineNdjson = `${offlineRows.map(row => JSON.stringify(row)).join('\n')}\n`;

export const offlineWorkspace = {
  panels: {
    regions: { plugin: 'Datagrid', title: '区域选择', columns: ['区域', '数量'] },
    detail: { plugin: 'Datagrid', title: '订单明细', columns: Object.keys(offlineSchema) },
  },
  layout: {
    type: 'split-layout',
    orientation: 'horizontal',
    sizes: [0.4, 0.6],
    children: [
      { type: 'tab-layout', tabs: ['regions'] },
      { type: 'tab-layout', tabs: ['detail'] },
    ],
  },
  activePanel: 'detail',
  settings: false,
  masters: ['regions'],
  global_filters: [],
};
