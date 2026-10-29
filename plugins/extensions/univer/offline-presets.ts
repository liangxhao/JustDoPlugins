import '@univerjs/preset-sheets-filter/lib/index.css';
import '@univerjs/preset-sheets-sort/lib/index.css';
import '@univerjs/preset-sheets-find-replace/lib/index.css';
import '@univerjs/preset-sheets-data-validation/lib/index.css';
import '@univerjs/preset-sheets-conditional-formatting/lib/index.css';

import { UniverSheetsFilterPreset } from '@univerjs/preset-sheets-filter';
import filterEn from '@univerjs/preset-sheets-filter/locales/en-US';
import filterZh from '@univerjs/preset-sheets-filter/locales/zh-CN';
import { UniverSheetsSortPreset } from '@univerjs/preset-sheets-sort';
import sortEn from '@univerjs/preset-sheets-sort/locales/en-US';
import sortZh from '@univerjs/preset-sheets-sort/locales/zh-CN';
import { UniverSheetsFindReplacePreset } from '@univerjs/preset-sheets-find-replace';
import findEn from '@univerjs/preset-sheets-find-replace/locales/en-US';
import findZh from '@univerjs/preset-sheets-find-replace/locales/zh-CN';
import { UniverSheetsDataValidationPreset } from '@univerjs/preset-sheets-data-validation';
import validationEn from '@univerjs/preset-sheets-data-validation/locales/en-US';
import validationZh from '@univerjs/preset-sheets-data-validation/locales/zh-CN';
import { UniverSheetsConditionalFormattingPreset } from '@univerjs/preset-sheets-conditional-formatting';
import conditionalEn from '@univerjs/preset-sheets-conditional-formatting/locales/en-US';
import conditionalZh from '@univerjs/preset-sheets-conditional-formatting/locales/zh-CN';
import coreEn from '@univerjs/preset-sheets-core/locales/en-US';
import coreZh from '@univerjs/preset-sheets-core/locales/zh-CN';
import { mergeLocales, LocaleType, type IPreset } from '@univerjs/presets';
import { UniverSheetsPlugin, type IUniverSheetsConfig } from '@univerjs/sheets';
import { MAX_COLUMNS, MAX_ROWS } from '../../../shared/contracts';

export const offlineLocales = {
  [LocaleType.EN_US]: mergeLocales(coreEn, filterEn, sortEn, findEn, validationEn, conditionalEn),
  [LocaleType.ZH_CN]: mergeLocales(coreZh, filterZh, sortZh, findZh, validationZh, conditionalZh),
};
export function offlinePresets() {
  return [UniverSheetsFilterPreset(), UniverSheetsSortPreset(), UniverSheetsFindReplacePreset(),
    UniverSheetsDataValidationPreset(), UniverSheetsConditionalFormattingPreset()];
}

/** Keep supported-size copy/delete operations synchronous and undoable. */
export function withOfflineSheetLimits(preset: IPreset): IPreset {
  let configured = false;
  const plugins = preset.plugins.map(plugin => {
    const [constructor, options] = Array.isArray(plugin) ? plugin : [plugin, undefined];
    if (constructor !== UniverSheetsPlugin) return plugin;
    configured = true;
    return [constructor, { ...options, largeSheetOperation: { largeSheetCellCountThreshold: (MAX_ROWS + 1) * MAX_COLUMNS + 1 } } satisfies IUniverSheetsConfig] as [typeof constructor, object];
  });
  if (!configured) throw new Error('The bundled sheets preset cannot apply offline operation limits.');
  return { ...preset, plugins };
}
