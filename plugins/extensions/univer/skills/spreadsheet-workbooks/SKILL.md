---
name: spreadsheet-workbooks
description: 创建和修改可交互的预算、排期、清单及表格，读取指定单元格，编写公式；支持离线 XLSX、CSV、TSV 导入导出。
---

Use the enabled OpenClaw spreadsheet extension for interactive spreadsheet work.
Discover its actual MCP tools before calling them; do not invent a server prefix
or assume the plugin is enabled. Use real user data and clearly label examples.

- Create a workbook with `create_spreadsheet`. Strings, including text beginning
  with `=`, are literal. Write a formula only through the explicit `formula` field.
- Use the exact document ID, sheet ID and current revision. `read_range` reads a
  bounded part of the saved workbook; `read_document` reads the saved snapshot.
  `update_cells` updates saved content at `expectedRevision` and preserves styles.
- Saved snapshots do not include unsaved editing. When the host exposes the
  admitted App's tools, use `spreadsheet_snapshot` / `spreadsheet_query` to read
  current editing and `spreadsheet_apply` to update that exact editor, supplying
  a fresh content stamp and unique operation ID. Only its applied response
  confirms a live edit. It remains unsaved until the user saves.
- Never route editing by a title or by the latest message. If more than one
  editor could be intended, resolve the target through the host's admitted view.
  On conflicts, read current content and reconcile the user's intent. Never
  replay an operation with a lost or uncertain response.
- File resources come from the host. Do not pass arbitrary filesystem paths or
  resource tokens in model context. Source-file writing is a separate approved,
  ETag-checked operation. Do not claim saved content or exported XLSX is a
  lossless Excel round trip, and do not promise unsupported Excel functions.
