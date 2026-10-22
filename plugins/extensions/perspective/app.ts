import '@perspective-dev/viewer-datagrid';
import '@perspective-dev/viewer-charts';
import '@perspective-dev/viewer/themes/pro.css';
import '@perspective-dev/viewer/themes/pro-dark.css';

import perspective, { type Client, type Table } from '@perspective-dev/client';
import clientWasm from '@perspective-dev/client/dist/wasm/perspective-js.wasm';
import serverWasm from '@perspective-dev/server/dist/wasm/perspective-server.wasm';
import viewer, { type ViewerConfigUpdate } from '@perspective-dev/viewer';
import viewerWasm from '@perspective-dev/viewer/dist/wasm/perspective-viewer.wasm';

import { csvRecords, toCsv } from '../../../shared/csv';
import { mountApp } from '../../../shared/ui';

const bytes = (base64: string) => Uint8Array.from(atob(base64), c => c.charCodeAt(0)).buffer;
perspective.init_client(bytes(clientWasm));
perspective.init_server(bytes(serverWasm));
await viewer.init_client(bytes(viewerWasm));

mountApp('Perspective', async (container, changed, app) => {
  const element = document.createElement('perspective-viewer');
  container.append(element);
  let worker: Client | undefined, table: Table | undefined;
  let source: Record<string, unknown>[] = [],
    loading = false;
  let applyingTheme = 0;
  const onConfig = () => {
    if (!loading && !applyingTheme) changed();
  };
  element.addEventListener('perspective-config-update', onConfig);
  const theme = new MutationObserver(() => {
    if (table) {
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
  return {
    async load(document) {
      loading = true;
      source = document.data.rows as Record<string, unknown>[];
      if (!source.length) {
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
      table = await worker.table(source, { name: document.id });
      await element.load(worker);
      await element.restore({
        settings: true,
        ...(document.data.config as ViewerConfigUpdate),
        table: document.id,
        theme: app.getHostContext()?.theme === 'dark' ? 'Pro Dark' : 'Pro Light',
      });
      element.addEventListener('perspective-select', event => {
        const detail = (event as CustomEvent).detail;
        void app
          .updateModelContext({
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  app: 'Perspective',
                  documentId: document.id,
                  selection: detail,
                }).slice(0, 12000),
              },
            ],
          })
          .catch(() => undefined);
      });
      loading = false;
    },
    async snapshot() {
      const config: Record<string, unknown> = table ? await element.save() : {};
      delete config.table;
      return { rows: source, config };
    },
    async importFile(file) {
      const text = await file.text();
      if (file.name.toLowerCase().endsWith('.json')) {
        const value = JSON.parse(text);
        return Array.isArray(value) ? { rows: value, config: {} } : value;
      }
      return {
        rows: csvRecords(text),
        config: {},
      };
    },
    async exportFile() {
      if (!table) return { text: '', extension: 'csv', mimeType: 'text/csv' };
      const view = await element.getView();
      const rows = (await view.to_json()) as Record<string, unknown>[];
      const columns = Array.from(new Set(rows.flatMap(row => Object.keys(row))));
      return {
        text: toCsv([columns, ...rows.map(row => columns.map(key => row[key]))]),
        extension: 'csv',
        mimeType: 'text/csv',
      };
    },
    async dispose() {
      theme.disconnect();
      element.removeEventListener('perspective-config-update', onConfig);
      await element.delete();
      await table?.delete();
      await worker?.terminate();
    },
  };
});
