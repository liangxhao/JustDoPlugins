import { z } from 'zod';

import { boundedQueryResult, rowsSchema, titleSchema, validateData } from '../../../shared/contracts';
import { startServer } from '../../../shared/server';
import {
  analysisConfigSchema,
  analysisSchema,
  analysisTypesSchema,
  analysisInspectSchema,
  queryWindowSchema,
} from '../../../shared/analysis';
import { createAnalysisValidator } from './validator';
import { analysisInputSchema } from './data-input';
import {
  analysisWorkspaceSchema,
  analysisWorkspacePatchSchema,
  patchAnalysisConfig,
  patchAnalysisWorkspace,
  type AnalysisData,
} from './workspace';

const validator = createAnalysisValidator(__dirname);

startServer(
  'perspective',
  'Perspective',
  () => ({ rows: [], config: {} }),
  [
    {
      name: 'preview_file',
      description:
        'Explore a host-authorized CSV, TSV, JSON, NDJSON or Arrow file. The source is read-only; save a copy to the local analysis library.',
      schema: z.object({
        file: z
          .object({
            name: z
              .string()
              .min(1)
              .max(255)
              .regex(/\.(csv|tsv|json|ndjson|jsonl|arrow|feather)$/i),
            resourceUri: z.string().startsWith('openclaw-file://').max(256),
          })
          .strict(),
      }),
      view: true,
      readOnly: true,
      fileExtensions: ['.csv', '.tsv', '.json', '.ndjson', '.jsonl', '.arrow', '.feather'],
      run: input => ({ file: input.file }),
    },
    {
      name: 'analyze_data',
      description:
        'Open real tabular data as an interactive Perspective analysis in the conversation. Users can group, filter, pivot, chart and export the data locally. Pass records with consistent columns; maximum 5000 rows and 100 columns.',
      schema: z.object({
        title: titleSchema,
        rows: rowsSchema.min(1),
        schema: analysisTypesSchema.optional(),
        config: analysisConfigSchema.default({}),
        workspace: analysisWorkspaceSchema.optional(),
      }),
      view: true,
      run: (input, store, { signal }) =>
        store.create(
          String(input.title),
          { rows: input.rows, schema: input.schema, config: input.config,
            ...(input.workspace !== undefined ? { workspace: input.workspace } : {}) },
          signal,
        ),
    },
    {
      name: 'import_analysis',
      description:
        'Import local JSON records/document, NDJSON, column arrays, CSV/TSV text or a base64 Arrow IPC blob as an interactive analysis. Text and binary input are limited to 2 MiB; normalized data to 5000 rows and 100 columns. Explicit types preserve integers and dates; strings such as "001" stay strings.',
      schema: analysisInputSchema.extend({ title: titleSchema }),
      view: true,
      run: async (input, store, { signal }) => {
        const { title, ...source } = input;
        const data = await validator.decode(analysisInputSchema.parse(source), signal);
        signal.throwIfAborted();
        return store.create(String(title), data, signal);
      },
    },
    {
      name: 'list_visualizations',
      description:
        'List the 14 available offline visualizations and their actual column, group and split roles from the public renderer registry. Column role labels describe ordered slots; initialCount is the upstream initial selection count.',
      schema: z.object({}),
      readOnly: true,
      run: (_input, _store, { signal }) => validator.visualizations(signal),
    },
    {
      name: 'inspect_analysis',
      description:
        'Inspect style controls or version-matched local help for expressions, windows and configuration. Provide exactly one saved id or unsaved data object; no document is created. Every panel is preflighted with the real local engine. Optionally select a panel, target plugin or styled column.',
      schema: analysisInspectSchema.extend({
        id: z.string().uuid().optional(),
        data: z.record(z.string(), z.unknown()).optional(),
      }),
      readOnly: true,
      run: (input, store, { signal }) => {
        const { id, data, ...options } = input;
        if ((id === undefined) === (data === undefined))
          throw new Error('Provide exactly one of id or data.');
        const source = id === undefined ? validateData('perspective', data) : store.get(String(id)).data;
        return validator.inspect(source, analysisInspectSchema.parse(options), signal);
      },
    },
    {
      name: 'query_analysis',
      description:
        'Read a page of actual filtered, grouped, pivoted or computed results from a saved analysis, optionally selecting a workspace panel. Result is limited to 100 rows, 20 columns and 256 KiB.',
      schema: queryWindowSchema.extend({ id: z.string().uuid() }),
      readOnly: true,
      run: async (input, store, { signal }) => {
        const { id, ...options } = input;
        const doc = store.get(String(id));
        const result = await validator.query(doc.data, queryWindowSchema.parse(options), signal);
        return boundedQueryResult({ id: doc.id, revision: doc.revision, ...result });
      },
    },
    {
      name: 'replace_data',
      description:
        'Replace the source records of an existing analysis using its exact current revision. The saved view configuration is preserved.',
      schema: z.object({
        id: z.string().uuid(),
        expectedRevision: z.number().int().positive(),
        rows: rowsSchema.min(1),
        schema: analysisTypesSchema.optional(),
        config: analysisConfigSchema.optional(),
        panelId: z.string().min(1).max(128).optional(),
        workspace: analysisWorkspaceSchema.optional(),
      }),
      view: true,
      run: (input, store, { signal }) => {
        const document = store.get(String(input.id));
        const previous = document.data.schema as Record<string, string> | undefined;
        const columns = new Set(
          (input.rows as Record<string, unknown>[]).flatMap(row => Object.keys(row)),
        );
        const schema =
          input.schema ??
          Object.fromEntries(Object.entries(previous ?? {}).filter(([name]) => columns.has(name)));
        let data: Record<string, unknown> = {
          ...document.data,
          rows: input.rows,
          schema,
          ...(input.workspace !== undefined ? { workspace: input.workspace } : {}),
        };
        if (input.config !== undefined) data = patchAnalysisConfig(data as unknown as AnalysisData,
          analysisConfigSchema.parse(input.config), input.panelId as string | undefined) as unknown as Record<string, unknown>;
        else if (input.panelId !== undefined)
          throw new Error('panelId requires a configuration patch.');
        return store.save(
          document.id,
          Number(input.expectedRevision),
          document.title,
          data,
          signal,
        );
      },
    },
    {
      name: 'read_analysis',
      description:
          'Read the saved analysis schema, workspace configuration and a page of source records. For saved filtered/aggregated results use query_analysis; for unsaved live results use the AppBridge analysis_query tool.',
      schema: z.object({
        id: z.string().uuid(),
        offset: z.number().int().min(0).max(5000).default(0),
        limit: z.number().int().min(1).max(100).default(25),
        includeConfig: z.boolean().default(true),
      }),
      readOnly: true,
      run: (input, store) => {
        const doc = store.get(String(input.id));
        const rows = doc.data.rows as z.infer<typeof rowsSchema>;
        const offset = Number(input.offset);
        return boundedQueryResult(
          {
            id: doc.id,
            title: doc.title,
            revision: doc.revision,
            rowCount: rows.length,
            schema: analysisSchema(rows, doc.data.schema),
            ...(input.includeConfig ? { config: doc.data.config,
              ...(doc.data.workspace ? { workspace: doc.data.workspace } : {}) } : { configOmitted: true }),
            offset,
            rows: rows.slice(offset, offset + Number(input.limit)),
            hasMore: offset + Number(input.limit) < rows.length,
          },
          'Request fewer rows, or set includeConfig=false when the configuration is large.',
        );
      },
    },
    {
      name: 'configure_analysis',
      description:
        'Patch a saved analysis configuration (group_by, split_by, columns, filter, sort, aggregates, expressions or chart plugin) using its exact revision. Omitted keys are preserved; arrays replace the corresponding setting.',
      schema: z.object({
        id: z.string().uuid(),
        expectedRevision: z.number().int().positive(),
        config: analysisConfigSchema,
        panelId: z.string().min(1).max(128).optional(),
      }),
      view: true,
      run: (input, store, { signal }) => {
        const doc = store.get(String(input.id));
        return store.save(
          doc.id,
          Number(input.expectedRevision),
          doc.title,
          patchAnalysisConfig(doc.data as unknown as AnalysisData,
            analysisConfigSchema.parse(input.config), input.panelId as string | undefined),
          signal,
        );
      },
    },
    {
      name: 'configure_workspace',
      description:
        'Patch a local multi-panel analysis workspace using its exact current revision. Up to 8 panels share one source table. A supplied panels object replaces all panels; layout and masters must reference those IDs. The active panel supplies the legacy config mirror.',
      schema: z.object({
        id: z.string().uuid(),
        expectedRevision: z.number().int().positive(),
        workspace: analysisWorkspacePatchSchema,
      }),
      view: true,
      run: (input, store, { signal }) => {
        const doc = store.get(String(input.id));
        return store.save(doc.id, Number(input.expectedRevision), doc.title,
          patchAnalysisWorkspace(doc.data as unknown as AnalysisData,
            analysisWorkspacePatchSchema.parse(input.workspace)), signal);
      },
    },
    {
      name: 'append_data',
      description:
        'Append records to a saved analysis at an exact revision, preserving its view configuration. Total capacity remains 5000 rows and 100 columns.',
      schema: z.object({
        id: z.string().uuid(),
        expectedRevision: z.number().int().positive(),
        rows: rowsSchema.min(1),
      }),
      view: true,
      run: (input, store, { signal }) => {
        const doc = store.get(String(input.id));
        return store.save(
          doc.id,
          Number(input.expectedRevision),
          doc.title,
          {
            ...doc.data,
            rows: [...(doc.data.rows as unknown[]), ...(input.rows as unknown[])],
          },
          signal,
        );
      },
    },
  ],
  { validateDocument: validator.validate, close: validator.close },
);
