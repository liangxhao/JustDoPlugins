---
name: tabular-analysis
description: 分析表格记录，按维度分组、透视、筛选和聚合，生成交互图表并读取当前分析结果；支持离线 CSV、TSV、JSON。
---

Use the enabled OpenClaw analysis extension for interactive tabular analysis.
Discover its actual MCP tools first; do not invent a server prefix or silently
substitute fabricated data. Use one scalar type per source column; nulls and
missing values are permitted. Keep numeric identifiers as strings when needed.

- `analyze_data` opens records with an optional initial view configuration.
  `read_analysis` reads saved schema, configuration and a page of source rows.
- `configure_analysis` patches saved group_by, split_by, columns, filter, sort,
  aggregates, expressions or the chart plugin at an exact current revision.
  Arrays replace that setting; omitted settings are preserved. `append_data`
  adds source rows. `replace_data` can replace data and, if necessary, config.
- Saved content is separate from unsaved filtering and chart changes. For a
  host-admitted live editor, `analysis_snapshot` reads its identity and stamp;
  `analysis_query` returns a bounded window of the actual filtered, grouped and
  aggregated result; `analysis_apply` changes the exact live view configuration
  at a fresh stamp and unique operation ID. Only its applied response confirms
  a live update; it does not save the document or write a source file.
- Do not present raw source records as aggregated results. Query actual results
  and paginate columns as well as rows when split_by creates many columns.
- On a conflict, read again and preserve user edits. Never retry an uncertain
  mutation or choose an editor by its title. Files use host-issued resources;
  CSV/TSV/JSON previews are read-only sources, and Save copy creates a local
  analysis document. Never claim remote data access, cloud sharing or maps.
