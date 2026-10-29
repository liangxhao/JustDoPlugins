---
name: spreadsheet-workbooks
description: 离线创建和编辑表格、公式与样式，管理工作表和行列，排序筛选并检查当前结果；支持XLSX、CSV、TSV和完整工作簿JSON。
---

Use the enabled OpenClaw spreadsheet extension for interactive spreadsheet work.
Discover its actual MCP tools before calling them; do not invent a server prefix
or assume the plugin is enabled. Use real user data and clearly label examples.

- Create a workbook with `create_spreadsheet`. Strings, including text beginning
  with `=`, are literal. Write a formula only through the explicit `formula` field.
- Use the exact document ID, sheet ID and current revision. `read_range` reads a
  bounded part of the saved workbook; `read_document` reads the saved snapshot.
  `update_cells` updates saved content at `expectedRevision` and preserves styles.
- `inspect_spreadsheet` discovers the actual operation schema and inspects sheets,
  styles, ranges or resource summaries. `edit_spreadsheet` applies one operation
  to a saved workbook at its exact revision. Use native structural operations so
  formulas follow worksheet renames and row/column changes; never rewrite formula
  references with string replacement.
- Saved snapshots do not include unsaved editing. When the host exposes the
  admitted App's tools, use `spreadsheet_snapshot` / `spreadsheet_query` to read
  current editing and `spreadsheet_apply` to update that exact editor, supplying
  a fresh content stamp and unique operation ID. Only its applied response
  confirms a live edit. It remains unsaved until the user saves.
- Live `spreadsheet_inspect` includes unsaved styles and structure. Submit
  `spreadsheet_apply.patch.operation` for one cells, format_range, clear_range,
  merge/unmerge, worksheet, row/column, freeze, sort_range or set_filter operation.
  It is an alternative to the legacy sheetId/cells patch, not an extra batch.
  Ranges are zero-based with inclusive endpoints. Read the supported schema first.
  A native command preserves the editor and its undo history; use one fresh stamp
  for each operation. Copying a sheet uses the engine's generated ID and name:
  discover the actual new ID in the returned snapshot before further edits.
- When the user asks to save, call the admitted editor's `spreadsheet_save`
  with its exact documentId, a fresh baseContentStamp and a new operationId.
  Default mode `document` saves that local document; explicit mode `copy`
  creates a local copy. Source files allow copy only through this tool; their
  approved source-file write remains a separate UI action. Read savedDocument
  and snapshot separately: later user edits can remain dirty, and a saved copy
  need not replace the current editor. snapshotUnavailable after status saved
  still confirms persistence. Never rebuild a workbook from its bounded preview
  or repeat an unknown save. On the library screen there is no active document.
- Formatting uses the bounded public style fields. Example: style
  {bl:1,bg:{rgb:'#E8F0FE'},n:{pattern:'#,##0.00'}}. A range style operation preserves
  existing values and unspecified styles. Merges reject discarded cell contents
  unless discardValues is explicitly requested. Keep at least one visible sheet.
- Filter, validation and conditional-format rules persist in the local document
  and full workbook JSON. The current XLSX converter rejects active rules it
  cannot preserve; use full JSON instead of promising an equivalent XLSX. CSV/TSV
  export includes the active sheet's values, without styles or rules.
- Never route editing by a title or by the latest message. If more than one
  editor could be intended, resolve the target through the host's admitted view.
  On conflicts, read current content and reconcile the user's intent. Never
  replay an operation with a lost or uncertain response.
- File resources come from the host. Do not pass arbitrary filesystem paths or
  resource tokens in model context. Source-file writing is a separate approved,
  ETag-checked operation. Do not claim saved content or exported XLSX is a
  lossless Excel round trip, and do not promise unsupported Excel functions.
- Structural and rule changes cannot be written back to the original XLSX.
  Preserve the draft and save a local copy or full JSON. Never retry an uncertain
  source-file write or describe a local-document save as a source-file update.
