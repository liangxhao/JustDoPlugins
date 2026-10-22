import { parentPort } from 'node:worker_threads';
import { table as createTable, type Table } from '@perspective-dev/client/node';

import { type Scalar } from '../../../shared/contracts';
import {
  analysisSchema,
  analysisValue,
  analysisEngineConfig,
  validateAnalysisConfig,
} from '../../../shared/analysis';
import { validateStyles } from './style-contracts.mjs';

if (!parentPort) throw new Error('Analysis validation requires a worker.');
parentPort.on('message', async (message: { id: number; data: Record<string, unknown> }) => {
  let table: Table | undefined;
  let view: Awaited<ReturnType<Table['view']>> | undefined;
  let error: string | undefined;
  try {
    const rows = message.data.rows as Record<string, Scalar>[];
    const schema = analysisSchema(rows, message.data.schema);
    const config = validateAnalysisConfig(message.data.config, rows, schema);
    // An empty document has no column types from which an engine table can be
    // constructed. Only an unconfigured blank document is meaningful here.
    if (!Object.keys(schema).length) {
      if (
        Object.keys(analysisEngineConfig(config)).some(key => {
          const value = (config as Record<string, unknown>)[key];
          return (
            value != null &&
            (Array.isArray(value)
              ? value.length > 0
              : typeof value === 'object'
                ? Object.keys(value).length > 0
                : true)
          );
        })
      )
        throw new Error('Import data before configuring an empty analysis.');
    } else {
      table = await createTable(schema);
      await table.update(
        rows.map(row =>
          Object.fromEntries(Object.keys(schema).map(name => [name, analysisValue(row, name)])),
        ),
      );
      view = await table.view(analysisEngineConfig(config) as Parameters<Table['view']>[0]);
    }
    validateStyles(config, {
      ...schema,
      ...(await view?.expression_schema()),
      ...(await view?.schema()),
    });
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    try {
      await view?.delete();
      await table?.delete();
    } catch (cause) {
      error ??= cause instanceof Error ? cause.message : String(cause);
    }
  }
  parentPort!.postMessage({ id: message.id, ...(error ? { error } : {}) });
});
