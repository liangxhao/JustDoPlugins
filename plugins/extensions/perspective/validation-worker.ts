import { parentPort } from 'node:worker_threads';
import { table as createTable, type Table } from '@perspective-dev/client/node';

import { boundedQueryResult, validateData } from '../../../shared/contracts';
import {
  analysisValue,
  analysisEngineConfig,
  analysisInspectSchema,
  queryWindowSchema,
  normalizeAnalysisFilters,
  type AnalysisTypes,
} from '../../../shared/analysis';
import {
  activeAnalysisConfig,
  effectiveAnalysisConfig,
  type AnalysisConfig,
  type AnalysisData,
} from './workspace';
import {
  analysisReference,
  inspectAnalysisStyles,
  listAnalysisVisualizations,
  validateStyles,
} from './style-contracts.mjs';
import { parseAnalysisInput, type AnalysisInput } from './data-input';

interface WorkerRequest {
  id: number;
  task: 'validate' | 'query' | 'inspect' | 'decode' | 'visualizations';
  data?: Record<string, unknown>;
  options?: unknown;
  input?: AnalysisInput;
}
interface Description {
  config_error?: string;
  expression_errors?: Record<string, unknown>;
  expression_schema?: Record<string, string>;
  view_schema?: Record<string, string>;
}

function checkDescription(description: Description) {
  if (description.config_error) throw new Error(description.config_error);
  if (Object.keys(description.expression_errors ?? {}).length)
    throw new Error(`Invalid expressions: ${JSON.stringify(description.expression_errors)}`);
  return description;
}
function blankDescription(config: AnalysisConfig): Description {
  if (Object.values(analysisEngineConfig(config)).some(value => value != null &&
    (Array.isArray(value) ? value.length > 0
      : typeof value === 'object' ? Object.keys(value).length > 0 : true)))
    throw new Error('Import data before configuring an empty analysis.');
  return { expression_schema: {}, view_schema: {} };
}

async function execute(message: WorkerRequest): Promise<unknown> {
  if (message.task === 'visualizations')
    return { visualizations: listAnalysisVisualizations() };
  if (message.task === 'decode')
    return parseAnalysisInput(message.input!, createTable);

  const data = validateData('perspective', message.data) as unknown as AnalysisData;
  const schema = data.schema!;
  let table: Table | undefined;
  let view: Awaited<ReturnType<Table['view']>> | undefined;
  try {
    if (Object.keys(schema).length) {
      table = await createTable(schema);
      if (data.rows.length) await table.update(data.rows.map(row =>
        Object.fromEntries(Object.keys(schema).map(name => [name, analysisValue(row, name)])),
      ));
    }
    const describe = async (config: AnalysisConfig) => {
      const description = table
        ? checkDescription(await table.describe(analysisEngineConfig(config) as Parameters<Table['describe']>[0]) as Description)
        : blankDescription(config);
      return { ...description, normalizedConfig: normalizeAnalysisFilters(config,
        { ...description.view_schema, ...description.expression_schema, ...schema } as AnalysisTypes) };
    };
    // Global filters remain meaningful when all panels are masters or removed.
    // Validate them against the common source independently of panel merging.
    if (data.workspace?.global_filters?.length)
      await describe({ filter: data.workspace.global_filters });
    // Inspect is also the unsaved editor's preflight endpoint. Check every
    // panel, including panels hidden behind tabs, before returning metadata.
    const panels = data.workspace ? Object.entries(data.workspace.panels) : [['main', data.config ?? {}] as const];
    for (const [id, ownConfig] of panels) {
      const config = effectiveAnalysisConfig(ownConfig, data.workspace, id);
      const description = await describe(config);
      validateStyles(config, { ...schema, ...description.expression_schema, ...description.view_schema });
    }
    if (message.task === 'validate') return undefined;

    if (message.task === 'query') {
      const options = queryWindowSchema.parse(message.options ?? {});
      const panelId = options.panelId ?? data.workspace?.activePanel ?? (data.workspace ? undefined : 'main');
      if (data.workspace && !Object.keys(data.workspace.panels).length)
        throw new Error('Create a panel before querying the analysis.');
      const config = effectiveAnalysisConfig(activeAnalysisConfig(data, options.panelId), data.workspace, panelId);
      const description = await describe(config);
      view = await table?.view(analysisEngineConfig(description.normalizedConfig) as Parameters<Table['view']>[0]);
      const [totalRows, totalColumns, rows] = view ? await Promise.all([
        view.num_rows(), view.num_columns(), view.to_json({
          start_row: options.offset, end_row: options.offset + options.limit,
          start_col: options.columnOffset, end_col: options.columnOffset + options.columnLimit,
        }),
      ]) : [0, 0, []];
      return boundedQueryResult({ panelId, ...options, totalRows, totalColumns, rows,
        hasMoreRows: options.offset + rows.length < totalRows,
        hasMoreColumns: options.columnOffset + options.columnLimit < totalColumns });
    }

    const options = analysisInspectSchema.parse(message.options ?? {});
    const panelId = options.panelId ?? data.workspace?.activePanel ?? (data.workspace ? undefined : 'main');
    const ownConfig = activeAnalysisConfig(data, options.panelId);
    const config = effectiveAnalysisConfig({ ...ownConfig,
      ...(options.plugin ? { plugin: options.plugin } : {}) }, data.workspace, panelId);
    const description = await describe(config);
    const types = { ...schema, ...description.expression_schema, ...description.view_schema };
    const reference = options.section === 'all'
      ? Object.fromEntries(['expressions', 'windows', 'configuration'].map(section =>
        [section, analysisReference(section, options.search, options.limit)]))
      : options.section === 'styles' ? undefined
        : analysisReference(options.section, options.search, options.limit);
    return boundedQueryResult({ panelId, sourceSchema: schema,
      expressionSchema: description.expression_schema ?? {}, viewSchema: description.view_schema ?? {},
      ...(['styles', 'all'].includes(options.section)
        ? { styles: inspectAnalysisStyles(config, types, options.column) } : {}),
      ...(reference ? { reference } : {}),
    }, 'Inspect one section or column at a time, or reduce the help limit.');
  } finally {
    try { await view?.delete(); } finally { await table?.delete(); }
  }
}

if (!parentPort) throw new Error('Analysis validation requires a worker.');
parentPort.on('message', async (message: WorkerRequest) => {
  try {
    const result = await execute(message);
    parentPort!.postMessage({ id: message.id, result });
  } catch (cause) {
    parentPort!.postMessage({ id: message.id,
      error: cause instanceof Error ? cause.message : String(cause) });
  }
});
