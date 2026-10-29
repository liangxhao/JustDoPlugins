import { z } from 'zod';

import { analysisConfigSchema, queryWindowSchema } from '../../../shared/analysis';
import { rowsSchema, scalar } from '../../../shared/contracts';
import { analysisWorkspacePatchSchema } from './workspace';

export const analysisApplySchema = z.object({
  panelId: z.string().min(1).max(128).optional(),
  config: analysisConfigSchema.optional(),
  workspace: analysisWorkspacePatchSchema.optional(),
  cells: z.array(z.object({ row: z.number().int().min(0).max(4999), column: z.string().min(1).max(120), value: scalar }).strict()).min(1).max(2000).optional(),
  append: rowsSchema.optional(),
  rows: rowsSchema.optional(),
}).strict().refine(value => value.config || value.workspace || value.cells || value.append || value.rows, 'Provide a configuration, workspace or source edit.');
export const analysisQuerySchema = queryWindowSchema.extend({ panelId: z.string().min(1).max(128).optional() });
export const analysisInspectSchema = z.object({
  kind: z.enum(['workspace', 'plugins', 'style', 'source', 'selection']),
  panelId: z.string().min(1).max(128).optional(),
  plugin: analysisConfigSchema.shape.plugin.optional(),
  column: z.string().min(1).max(120).optional(),
  section: z.enum(['styles', 'expressions', 'windows', 'configuration', 'all']).default('styles'),
  search: z.string().max(120).optional(),
  offset: z.number().int().min(0).max(5000).default(0),
  limit: z.number().int().min(1).max(100).default(25),
}).strict();
