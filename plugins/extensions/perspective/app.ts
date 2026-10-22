import '@perspective-dev/viewer-datagrid';
import '@perspective-dev/viewer-charts';
import '@perspective-dev/viewer/themes/pro.css';
import '@perspective-dev/viewer/themes/pro-dark.css';

import perspective, { type Client, type Table, type View } from '@perspective-dev/client';
import clientWasm from '@perspective-dev/client/dist/wasm/perspective-js.wasm';
import serverWasm from '@perspective-dev/server/dist/wasm/perspective-server.wasm';
import viewer, { type ViewerConfigUpdate } from '@perspective-dev/viewer';
import viewerWasm from '@perspective-dev/viewer/dist/wasm/perspective-viewer.wasm';

import { csvRecords, toCsv } from '../../../shared/csv';
import { mountApp } from '../../../shared/ui';
import { rowsSchema, type Scalar, validateData } from '../../../shared/contracts';
import {
  analysisConfigSchema,
  analysisEngineConfig,
  analysisSchema,
  analysisValue,
  type AnalysisTypes,
  queryWindowSchema,
  validateAnalysisConfig,
} from '../../../shared/analysis';
import { z } from 'zod';
import { validateStyleFields, type StyleSchema } from '../../../shared/style-validation';

const applySchema = z.object({ config: analysisConfigSchema }).strict();
async function importAnalysisFile(file: File) {
  if (!/\.(csv|tsv|json)$/i.test(file.name)) throw new Error('Supported formats: CSV, TSV, JSON.');
  if (file.size > 2 * 1024 * 1024) throw new Error('Analysis input exceeds 2 MiB.');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
  const value = /\.json$/i.test(file.name)
    ? JSON.parse(text.replace(/^\uFEFF/, ''))
    : csvRecords(text);
  return validateData('perspective', Array.isArray(value) ? { rows: value, config: {} } : value);
}

const bytes = (base64: string) => Uint8Array.from(atob(base64), c => c.charCodeAt(0)).buffer;
perspective.init_client(bytes(clientWasm));
perspective.init_server(bytes(serverWasm));
await viewer.init_client(bytes(viewerWasm));

mountApp(
  'Perspective',
  async (container, changed, app, _initialDocument, requestContext) => {
    const element = document.createElement('perspective-viewer');
    container.append(element);
    let worker: Client | undefined, table: Table | undefined, sourceView: View | undefined;
    let source: Record<string, Scalar>[] = [],
      loading = false;
    let sourceSchema: AnalysisTypes = {};
    let applyingTheme = 0;
    let disposed = false;
    let selection: unknown;
    const onConfig = () => {
      if (!disposed && !loading && !applyingTheme) changed();
    };
    element.addEventListener('perspective-config-update', onConfig);
    const theme = new MutationObserver(() => {
      if (table && !disposed) {
        applyingTheme++;
        void element
          .restore({
            theme: document.documentElement.dataset.theme === 'dark' ? 'Pro Dark' : 'Pro Light',
          })
          .catch(() => undefined)
          .finally(() => {
            applyingTheme--;
          });
      }
    });
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    async function config() {
      if (disposed) throw new Error('Analysis is closed.');
      await element.flush();
      const current: Record<string, unknown> = table ? await element.save() : {};
      delete current.table;
      // Presentation theme belongs to the host, not the saved analysis identity.
      delete current.theme;
      return current;
    }
    async function refreshSource() {
      if (disposed) throw new Error('Analysis is closed.');
      if (sourceView) source = rowsSchema.parse(await sourceView.to_json());
      return source;
    }
    async function query(input: Record<string, unknown>) {
      const window = queryWindowSchema.parse(input);
      if (!table) return { totalRows: 0, totalColumns: 0, ...window, rows: [] };
      await element.flush();
      const view = await element.getView();
      const [totalRows, totalColumns, rows] = await Promise.all([
        view.num_rows(),
        view.num_columns(),
        view.to_json({
          start_row: window.offset,
          end_row: window.offset + window.limit,
          start_col: window.columnOffset,
          end_col: window.columnOffset + window.columnLimit,
        }),
      ]);
      return {
        totalRows,
        totalColumns,
        ...window,
        rows,
        hasMoreRows: window.offset + rows.length < totalRows,
        hasMoreColumns: window.columnOffset + window.columnLimit < totalColumns,
      };
    }
    return {
      async load(document) {
        loading = true;
        source = rowsSchema.parse(document.data.rows);
        sourceSchema = analysisSchema(source, document.data.schema);
        if (!Object.keys(sourceSchema).length) {
          const empty = window.document.createElement('div');
          empty.className = 'empty';
          empty.textContent = app.getHostContext()?.locale?.startsWith('zh')
            ? '导入 CSV 开始分析'
            : 'Import a CSV to start';
          element.hidden = true;
          container.append(empty);
          loading = false;
          return;
        }
        worker = await perspective.worker();
        if (disposed) {
          await worker.terminate();
          throw new Error('Analysis load was cancelled.');
        }
        const schema = sourceSchema;
        table = await worker.table(schema, { name: document.id });
        await table.update(
          source.map(row =>
            Object.fromEntries(Object.keys(schema).map(name => [name, analysisValue(row, name)])),
          ),
        );
        // Datagrid can edit the actual table. Keep an unfiltered source view so
        // snapshots/save include those edits rather than the original input array.
        sourceView = await table.view({});
        await sourceView.on_update(() => {
          if (!disposed && !loading) changed();
        });
        await element.load(worker);
        await element.restore({
          settings: true,
          ...(document.data.config as ViewerConfigUpdate),
          table: document.id,
          theme: app.getHostContext()?.theme === 'dark' ? 'Pro Dark' : 'Pro Light',
        });
        element.addEventListener('perspective-select', event => {
          if (disposed) return;
          selection = (event as CustomEvent).detail;
          requestContext?.();
        });
        loading = false;
      },
      async snapshot() {
        await element.flush();
        return { rows: await refreshSource(), schema: sourceSchema, config: await config() };
      },
      async describe() {
        await refreshSource();
        return {
          rowCount: source.length,
          schema: sourceSchema,
          selection,
          config: await config(),
          preview: await query({ limit: 10, columnLimit: 10 }),
        };
      },
      query,
      async apply(input, unchanged) {
        if (!table || disposed) throw new Error('Import data before configuring the analysis.');
        const patch = applySchema.parse(input);
        const before = await config();
        const next = validateAnalysisConfig({ ...before, ...patch.config }, source, sourceSchema);
        // Validate query semantics in the actual engine without changing the live viewer.
        const engine = analysisEngineConfig(next);
        const probe = await table.view(engine as Parameters<Table['view']>[0]);
        try {
          const plugin = element.getPlugin(next.plugin ?? undefined);
          const pluginConfig = next.plugin_config ?? {};
          validateStyleFields(
            pluginConfig,
            (plugin.plugin_config_schema?.(next, pluginConfig) as StyleSchema) ?? { fields: [] },
            true,
          );
          const types = {
            ...sourceSchema,
            ...(await probe.expression_schema()),
            ...(await probe.schema()),
          };
          for (const [name, style] of Object.entries(next.columns_config ?? {})) {
            if (!Object.hasOwn(types, name))
              throw new Error(`Unknown styled analysis column: ${name}`);
            const slot = next.columns?.indexOf(name) ?? -1;
            const group = plugin.get_static_config().config_column_names?.[slot];
            const role =
              !next.columns || next.columns.includes(name)
                ? 'column'
                : next.split_by?.includes(name)
                  ? 'split_by'
                  : next.group_by?.includes(name)
                    ? 'group_by'
                    : 'column';
            validateStyleFields(
              style,
              (plugin.column_config_schema?.(
                types[name],
                group,
                name,
                style,
                next,
                pluginConfig,
                role,
              ) as StyleSchema) ?? { fields: [] },
              true,
            );
          }
        } finally {
          await probe.delete();
        }
        if (!unchanged()) throw new Error('CONFLICT: Analysis changed before applying.');
        element.inert = true;
        loading = true;
        try {
          await element.restore(next as ViewerConfigUpdate);
          await element.flush();
        } catch (error) {
          await element.restore(before as ViewerConfigUpdate);
          throw error;
        } finally {
          loading = false;
          element.inert = false;
        }
      },
      async exportFile() {
        if (!table) return { text: '', extension: 'csv', mimeType: 'text/csv' };
        await element.flush();
        const view = await element.getView();
        const totalRows = await view.num_rows(),
          totalColumns = await view.num_columns();
        if (totalRows > 20000 || totalColumns > 200 || totalRows * totalColumns > 500000)
          throw new Error('The pivot result is too large to export. Reduce the view first.');
        const rows = (await view.to_json()) as Record<string, unknown>[];
        const columns = Array.from(new Set(rows.flatMap(row => Object.keys(row))));
        return {
          text: toCsv([columns, ...rows.map(row => columns.map(key => row[key]))]),
          extension: 'csv',
          mimeType: 'text/csv',
        };
      },
      async dispose() {
        if (disposed) return;
        disposed = true;
        theme.disconnect();
        element.removeEventListener('perspective-config-update', onConfig);
        try {
          await element.delete();
        } finally {
          try {
            await sourceView?.delete();
          } finally {
            try {
              await table?.delete();
            } finally {
              await worker?.terminate();
            }
          }
        }
      },
    };
  },
  {
    kind: 'perspective',
    importFile: importAnalysisFile,
    applySchema,
    querySchema: queryWindowSchema,
    accept: '.csv,.tsv,.json',
  },
);
