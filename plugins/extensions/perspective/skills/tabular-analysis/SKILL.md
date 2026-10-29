---
name: tabular-analysis
description: 离线分析表格，创建和修改14种交互视图、多面板与点击联动；读取当前结果、发现样式及计算规范，支持CSV、JSON、NDJSON、Arrow。
---

Use the enabled OpenClaw analysis extension for interactive tabular analysis.
Discover its actual MCP tools first; do not invent a server prefix or silently
substitute fabricated data. Use one scalar type per source column; nulls and
missing values are permitted. Keep numeric identifiers as strings when needed.

- `analyze_data` opens records with optional schema, config or workspace.
  `import_analysis` accepts local text (JSON, column arrays, NDJSON, CSV/TSV) or
  a base64 Arrow blob. Preserve identifiers as strings; declare integer/date/
  datetime only for matching values. `read_analysis` pages saved source rows;
  `query_analysis` reads the saved panel's actual aggregated result.
- Call `list_visualizations` before choosing a renderer. Its column roles are
  ordered slots, not arbitrary labels. `inspect_analysis` accepts a saved id
  or transient data (exactly one) and exposes actual dynamic style schemas or
  version-matched expression/window/configuration help. Never guess styles.
- `configure_analysis` patches saved group_by, split_by, columns, filter, sort,
  aggregates, expressions or the chart plugin at an exact current revision.
  Arrays replace that setting; omitted settings are preserved. `append_data`
  adds source rows. `replace_data` can replace data and, if necessary, config
  and workspace. `configure_workspace` patches up to eight local panels,
  layout, activePanel, masters, global_filters and palette. A supplied panels
  map replaces the complete panel set; other workspace fields patch in place.
  Every panel shares this document's source table. Never pass table bindings.
- Saved content is separate from unsaved filtering and chart changes. For a
  host-admitted live editor, `analysis_snapshot` reads its identity and stamp;
  `analysis_query` returns a bounded window of the actual filtered, grouped and
  aggregated result, including linked click filters. Use an explicit panelId
  when several panels exist. `analysis_inspect` reads the full unsaved workspace,
  source pages, selection, renderer roles or style/computation contracts.
  `analysis_apply` changes the exact live view configuration and workspace
  at a fresh stamp and unique operation ID. Only its applied response confirms
  a live update; it does not save the document or write a source file.
- When the user requests persistence, use `analysis_save` on that admitted
  editor with documentId, a fresh baseContentStamp and a unique operationId.
  Mode `document` saves the current local document; explicit mode `copy`
  creates a local copy and is required for file previews. Check savedDocument
  and the current snapshot separately: user edits made while saving remain
  dirty, and a new copy may not become the current document. A confirmed saved
  result with snapshotUnavailable still means the write succeeded. Never
  reconstruct the full document from bounded previews or replay an unknown save.
  On the library screen there is no current document to edit.
- For live creation, submit patch.workspace.panels with stable caller-chosen
  IDs, set activePanel, and provide a split-layout or tab-layout. Choose master
  panel IDs to let user clicks filter detail panels; global_filters persists
  the resulting overlay. For edits, patch.config plus panelId updates one
  panel. patch.cells uses zero-based source rows and column names; append or
  rows can change records within the existing schema. Read a fresh stamp first.
- Filters use AND. For OR, create a boolean expression column and filter it;
  the pinned viewer cannot reliably round-trip filter_op:or. PNG export uses
  an isolated renderer to preserve the user's active linked selection.
- Do not present raw source records as aggregated results. Query actual results
  and paginate columns as well as rows when split_by creates many columns.
- On a conflict, read again and preserve user edits. Never retry an uncertain
  mutation or choose an editor by its title. Files use host-issued resources;
  CSV/TSV/JSON previews are read-only sources, and Save copy creates a local
  analysis document. Never claim remote data access, cloud sharing or maps.
