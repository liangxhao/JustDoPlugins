import { z } from 'zod';

import { boundedQueryResult, rowsSchema, titleSchema } from '../../../shared/contracts';
import { startServer } from '../../../shared/server';
import {
  analysisConfigSchema,
  analysisSchema,
  analysisTypesSchema,
} from '../../../shared/analysis';
import { createAnalysisValidator } from './validator';

const validator = createAnalysisValidator(__dirname);

startServer(
  'perspective',
  'Perspective',
  () => ({ rows: [], config: {} }),
  [
    {
      name: 'preview_file',
      description:
        'Explore a host-authorized CSV, TSV or JSON file. The source is read-only; save a copy to the local analysis library.',
      schema: z.object({
        file: z
          .object({
            name: z
              .string()
              .min(1)
              .max(255)
              .regex(/\.(csv|tsv|json)$/i),
            resourceUri: z.string().startsWith('openclaw-file://').max(256),
          })
          .strict(),
      }),
      view: true,
      readOnly: true,
      fileExtensions: ['.csv', '.tsv', '.json'],
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
      }),
      view: true,
      run: (input, store, { signal }) =>
        store.create(
          String(input.title),
          { rows: input.rows, schema: input.schema, config: input.config },
          signal,
        ),
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
        return store.save(
          document.id,
          Number(input.expectedRevision),
          document.title,
          {
            ...document.data,
            rows: input.rows,
            schema,
            ...(input.config ? { config: input.config } : {}),
          },
          signal,
        );
      },
    },
    {
      name: 'read_analysis',
      description:
        'Read the saved analysis schema, view configuration and a page of source records. For current filtered/aggregated results use the AppBridge analysis_query tool.',
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
            ...(input.includeConfig ? { config: doc.data.config } : { configOmitted: true }),
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
            config: { ...(doc.data.config as object), ...(input.config as object) },
          },
          signal,
        );
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
