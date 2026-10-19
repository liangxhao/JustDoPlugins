import { z } from 'zod';

import { rowsSchema, titleSchema } from '../../shared/contracts';
import { startServer } from '../../shared/server';

startServer('perspective', 'Perspective', () => ({ rows: [], config: {} }), [
  {
    name: 'analyze_data',
    description:
      'Open real tabular data as an interactive Perspective analysis in the conversation. Users can group, filter, pivot, chart and export the data locally. Pass records with consistent columns; maximum 5000 rows and 100 columns.',
    schema: z.object({
      title: titleSchema,
      rows: rowsSchema.min(1),
      config: z.record(z.string(), z.unknown()).default({}),
    }),
    view: true,
    run: (input, store) =>
      store.create(String(input.title), { rows: input.rows, config: input.config }),
  },
  {
    name: 'replace_data',
    description:
      'Replace the source records of an existing analysis using its exact current revision. The saved view configuration is preserved.',
    schema: z.object({
      id: z.string().uuid(),
      expectedRevision: z.number().int().positive(),
      rows: rowsSchema.min(1),
    }),
    view: true,
    run: (input, store) => {
      const document = store.get(String(input.id));
      return store.save(document.id, Number(input.expectedRevision), document.title, {
        ...document.data,
        rows: input.rows,
      });
    },
  },
]);
