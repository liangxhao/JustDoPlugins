import { z } from 'zod';

import {
  analysisConfigSchema,
  validateAnalysisConfig,
  type AnalysisTypes,
} from '../../../shared/analysis';
import type { Scalar } from '../../../shared/contracts';
import { validateStyleFields } from '../../../shared/style-validation';

export type AnalysisConfig = z.infer<typeof analysisConfigSchema>;
export type AnalysisLayout =
  | { type: 'tab-layout'; tabs: string[]; selected?: number }
  | { type: 'split-layout'; children: AnalysisLayout[]; sizes: number[]; orientation: 'horizontal' | 'vertical' };
const panelId = z.string().min(1).max(128).refine(
  value => !['__proto__', 'constructor', 'prototype'].includes(value), 'Invalid panel ID.',
);
const layoutSchema: z.ZodType<AnalysisLayout> = z.lazy(() => z.union([
  z.object({ type: z.literal('tab-layout'), tabs: z.array(panelId).min(1).max(8), selected: z.number().int().min(0).optional() }).strict(),
  z.object({ type: z.literal('split-layout'), children: z.array(layoutSchema).min(1).max(8), sizes: z.array(z.number().finite().positive()).min(1).max(8), orientation: z.enum(['horizontal', 'vertical']) }).strict(),
]));
const fields = {
  version: z.string().max(64).optional(),
  panels: z.record(panelId, analysisConfigSchema).refine(value => Object.keys(value).length <= 8, 'At most 8 panels are supported.'),
  layout: layoutSchema.nullable().optional(),
  activePanel: panelId.nullable().optional(),
  settings: z.boolean().optional(),
  masters: z.array(panelId).max(8).optional(),
  global_filters: analysisConfigSchema.shape.filter,
  palette: z.record(z.string().regex(/^--psp-user--(?:color|palette|gradient)-[\w-]+$/).max(128), z.string().max(8192)).refine(value => Object.keys(value).length <= 32).optional(),
};
export const analysisWorkspaceSchema = z.object(fields).strict();
export const analysisWorkspacePatchSchema = analysisWorkspaceSchema.partial();
export type AnalysisWorkspace = z.infer<typeof analysisWorkspaceSchema>;
export interface AnalysisData {
  rows: Record<string, Scalar>[];
  schema?: AnalysisTypes;
  config?: AnalysisConfig;
  workspace?: AnalysisWorkspace;
}

/** Only local panels are accepted. Table bindings are supplied by the editor. */
export function normalizeAnalysisWorkspace(value: unknown, rows: Record<string, Scalar>[], schema?: AnalysisTypes): AnalysisWorkspace {
  if (value && typeof value === 'object' && 'panels' in value && value.panels && typeof value.panels === 'object' && !Object.keys(value.panels).length &&
    'layout' in value && value.layout && typeof value.layout === 'object' && 'type' in value.layout && value.layout.type === 'split-layout' &&
    'children' in value.layout && Array.isArray(value.layout.children) && !value.layout.children.length &&
    'sizes' in value.layout && Array.isArray(value.layout.sizes) && !value.layout.sizes.length)
    value = { ...value, layout: null };
  // Bound recursive input before Zod traverses it, including direct tool input.
  const queue: { value: unknown; depth: number }[] = [{ value: (value as { layout?: unknown })?.layout, depth: 0 }];
  let count = 0;
  while (queue.length) {
    const node = queue.pop()!;
    if (++count > 64 || node.depth > 8) throw new Error('Workspace layout is too complex.');
    if (node.value && typeof node.value === 'object' && 'children' in node.value && Array.isArray(node.value.children))
      queue.push(...node.value.children.map(value => ({ value, depth: node.depth + 1 })));
  }
  const parsed = analysisWorkspaceSchema.parse(value);
  const ids = Object.keys(parsed.panels);
  const known = new Set(ids);
  parsed.panels = Object.fromEntries(Object.entries(parsed.panels).map(([id, config]) => {
    const { theme: _theme, settings: _settings, ...next } = validateAnalysisConfig(config, rows, schema);
    return [id, next];
  }));
  if (parsed.activePanel != null && !known.has(parsed.activePanel)) throw new Error('Unknown active panel.');
  parsed.activePanel = parsed.activePanel ?? ids[0] ?? null;
  parsed.settings ??= true;
  if (new Set(parsed.masters ?? []).size !== (parsed.masters ?? []).length || (parsed.masters ?? []).some(id => !known.has(id)))
    throw new Error('Workspace masters must reference unique existing panels.');
  if (parsed.layout) {
    const placed = new Set<string>();
    function walk(layout: AnalysisLayout) {
      if (layout.type === 'tab-layout') {
        if ((layout.selected ?? 0) >= layout.tabs.length) throw new Error('Invalid selected workspace tab.');
        for (const id of layout.tabs) {
          if (!known.has(id) || placed.has(id)) throw new Error('Workspace layout has unknown or repeated panels.');
          placed.add(id);
        }
      } else {
        if (layout.children.length !== layout.sizes.length) throw new Error('Workspace split sizes must match children.');
        for (const child of layout.children) walk(child);
      }
    }
    walk(parsed.layout);
    if (placed.size !== ids.length) throw new Error('Workspace layout must include every panel.');
    const collapse = (layout: AnalysisLayout): AnalysisLayout => layout.type === 'tab-layout' ? layout
      : layout.children.length === 1 ? collapse(layout.children[0])
        : { ...layout, children: layout.children.map(collapse) };
    parsed.layout = collapse(parsed.layout);
  }
  if (!ids.length && parsed.layout) throw new Error('An empty workspace cannot have a layout.');
  if (parsed.global_filters) {
    // Global filters must exist in every panel's common source, not in a private expression.
    parsed.global_filters = validateAnalysisConfig({ filter: parsed.global_filters }, rows, schema).filter;
  }
  for (const [key, item] of Object.entries(parsed.palette ?? {}))
    validateStyleFields({ value: item }, { fields: [{ key: 'value', kind: key.startsWith('--psp-user--color-') ? 'Color' : key.startsWith('--psp-user--palette-') ? 'Palette' : 'GradientStops' }] }, true);
  return parsed;
}

export function activeAnalysisConfig(data: AnalysisData, id?: string): AnalysisConfig {
  if (!data.workspace) {
    if (id !== undefined && id !== 'main') throw new Error(`Unknown analysis panel: ${id}`);
    return data.config ?? {};
  }
  const target = id ?? data.workspace.activePanel ?? Object.keys(data.workspace.panels)[0];
  if (!target) return {};
  if (!Object.hasOwn(data.workspace.panels, target)) throw new Error(`Unknown analysis panel: ${target}`);
  return data.workspace.panels[target];
}

export function patchAnalysisConfig<T extends AnalysisData>(data: T, patch: AnalysisConfig, panel?: string): T {
  const config = validateAnalysisConfig({ ...activeAnalysisConfig(data, panel), ...patch }, data.rows, data.schema);
  if (!data.workspace) return { ...data, config };
  const target = panel ?? data.workspace.activePanel ?? Object.keys(data.workspace.panels)[0];
  if (!target) throw new Error('Create a panel before configuring the analysis.');
  return patchAnalysisWorkspace(data, { panels: { ...data.workspace.panels, [target]: config },
    ...(patch.settings !== undefined ? { settings: patch.settings } : {}) });
}

export function patchAnalysisWorkspace<T extends AnalysisData>(data: T, patch: z.infer<typeof analysisWorkspacePatchSchema>): T {
  const base = data.workspace ?? { panels: { main: data.config ?? {} }, activePanel: 'main', settings: data.config?.settings ?? true };
  const workspace = normalizeAnalysisWorkspace({ ...base, ...analysisWorkspacePatchSchema.parse(patch) }, data.rows, data.schema);
  return { ...data, workspace, config: activeAnalysisConfig({ ...data, workspace }) };
}

export function effectiveAnalysisConfig(config: AnalysisConfig, workspace?: AnalysisWorkspace, panel?: string): AnalysisConfig {
  if (!workspace?.global_filters?.length || (panel && workspace.masters?.includes(panel))) return config;
  return { ...config, filter: [...(config.filter ?? []), ...workspace.global_filters] };
}
