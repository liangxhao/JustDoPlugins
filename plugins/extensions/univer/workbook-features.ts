import type { IWorkbookData } from '@univerjs/presets';

const featureNames: Record<string, string> = {
  SHEET_FILTER_PLUGIN: 'filters / 筛选',
  SHEET_DATA_VALIDATION_PLUGIN: 'data validation / 数据验证',
  SHEET_CONDITIONAL_FORMATTING_PLUGIN: 'conditional formatting / 条件格式',
};
function populated(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return false;
  if (Array.isArray(value)) return value.some(populated);
  if (typeof value === 'object') return Object.values(value).some(populated);
  return true;
}
export function workbookFeatureResources(workbook: IWorkbookData) {
  return Object.fromEntries((workbook.resources ?? [])
    .filter(resource => Object.hasOwn(featureNames, resource.name))
    .flatMap(resource => {
      if (!resource.data.trim()) return [];
      let value: unknown;
      try { value = JSON.parse(resource.data); }
      catch { throw new Error(`Invalid ${featureNames[resource.name]} project data.`); }
      return populated(value) ? [[resource.name, value]] : [];
    }));
}
/** Native project JSON retains plugin resources; the XLSX converter must not silently drop them. */
export function assertXlsxFeatureSupport(workbook: IWorkbookData) {
  const active = Object.entries(workbookFeatureResources(workbook))
    .filter(([, value]) => populated(value)).map(([name]) => featureNames[name]);
  if (active.length)
    throw new Error(`XLSX conversion cannot retain ${active.join(', ')}. Export the full workbook JSON to preserve them. / 请导出完整工作簿 JSON 以保留这些功能。`);
}
