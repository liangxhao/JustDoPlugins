# MCP App 能力审查与接口约定

审查更新：2026-10-30。适用范围为当前 Univer 与 Perspective 扩展，开发协议版本沿用 OpenClaw 2026.10.4 与锁定的 MCP Apps SDK。这里记录可交付的插件能力及仍需由接入方验收的边界。

## 审查结果

两个扩展原先已经具备真实离线编辑器、手动入口、本地文档库、revision 冲突检查和共享标题栏。Univer 还具有 XLSX 导入导出及受授权的工作区文件写回。主要缺口在于当前界面内容的读取、发送前同步、同一实例的连续修改，以及 Perspective 的文件和分析操作接口。

| 检查项           | 原有缺口                                       | 当前补齐内容                                                                                                                                                         |
| ---------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 应用发现         | 缺少图标和任务技能说明                         | 服务及工具提供内嵌明暗图标；原生清单声明随扩展启停的 Skill，交付包包含说明                                                                                           |
| 当前编辑状态     | 文档读取工具只能看到已保存数据                 | 每个 App 提供 snapshot 和 query 工具，读取准确实例及未保存内容                                                                                                       |
| 发送前准备       | 选区通知异步发送，不能证明当前输入已同步       | `prepare_context` 提交单元格输入，并等待真实 `updateModelContext` 完成后确认                                                                                         |
| 连续修改         | 服务端更新已保存数据，不能证明旧界面已经应用   | AppBridge apply 工具以文档 ID、内容戳和操作 ID 修改当前界面，成功返回实际应用确认                                                                                    |
| 并发编辑         | 仅持久化 revision 不能保护未保存手改           | 内容戳同时核对编辑器代次、编辑计数及完整快照；错误目标、过期及重复操作均拒绝                                                                                         |
| Univer 局部操作  | 读取整本工作簿成本较高；界面修改缺少事务接口   | 增加已保存 `read_range`、当前 `spreadsheet_query`；稀疏单元格修改作为一条可撤销命令执行                                                                              |
| Perspective 分析 | 只能创建或替换源数据，无法准确读取当前聚合结果 | 增加已保存 schema/记录分页、配置修改、追加记录，以及当前结果的行列窗口查询                                                                                           |
| Perspective 文件 | 缺少文件入口，TSV 未明确支持                   | 增加 CSV/TSV/JSON 原生只读文件入口及“保存副本”，保留数据与当前配置                                                                                                   |
| 数据正确性       | 首行推断可能漏列或丢失后续数值；配置未校验     | 使用全部记录建立并持久化显式类型，缺失字段按空值；读取真实源表编辑；拒绝混合类型、保留列、未知列及插件；禁用外部 table，所有持久化入口通过离线真实引擎及样式规范校验 |
| 加载与销毁       | 忙时通知被丢弃；新界面加载失败可能先销毁旧内容 | 串行处理结果通知，重复旧版本不重建；新编辑器成功后再替换旧界面，关闭后拒绝迟到操作                                                                                   |
| 静态资源         | 系统随机端口可能被浏览器禁止                   | 发布 URL/CSP 前筛选禁用端口，关闭后重新分配，最多 32 次                                                                                                              |
| 交付一致性       | 原生入口未完整纳入构建指纹                     | 编译两个原生入口，记录入口、校验器及 Skill 源码指纹，打包和启动检查所有资源哈希并复制原生 Skill                                                                      |

## 两层操作接口

stdio MCP 工具操作本地已保存文档。App 工具属于已加载的浏览器实例，通过标准 `AppBridge.listTools` / `AppBridge.callTool` 调用，不能将两个目录视为同一套工具。业务 ID、revision 和内容戳均不充当原生身份或权限凭据。

| 范围               | Univer                 | Perspective                                         |
| ------------------ | ---------------------- | --------------------------------------------------- |
| 创建持久文档       | `create_spreadsheet`   | `analyze_data`                                      |
| 局部读取已保存数据 | `read_range`           | `read_analysis`                                     |
| 更新已保存数据     | `update_cells`、`edit_spreadsheet` | `replace_data`、`append_data`、`configure_analysis`、`configure_workspace` |
| 当前实例快照       | `spreadsheet_snapshot` | `analysis_snapshot`                                 |
| 当前实例查询       | `spreadsheet_query`    | `analysis_query`                                    |
| 元数据与精确内容   | `read_range`、`inspect_spreadsheet`、`spreadsheet_inspect` | `list_visualizations`、`inspect_analysis`、`analysis_inspect` |
| 修改当前实例       | `spreadsheet_apply`    | `analysis_apply`                                    |
| 保存当前实例       | `spreadsheet_save`     | `analysis_save`                                     |
| 发送前准备         | `prepare_context`      | `prepare_context`                                   |

文档库的创建、读取、导入和保存接口沿用各插件详细说明。当前 App 的动态工具 schema 从真实 `listTools` 响应取得；新增能力不能只在文本中声明。

### 快照与内容戳

snapshot 无参数，返回 `structuredContent`：`kind`（`univer.snapshot.v1` 或 `perspective.snapshot.v1`）、`documentId`、`title`、`revision`、`dirty`、`contentStamp` 及有界的工作表/选区或 schema/分析配置/结果预览。文件预览的文档 ID 是当前临时业务 ID，与原生 viewId 分开。

预览中的长字符串截到 240 字符；摘要整体最多 16000 UTF-8 字节。大配置或宽数据不能完整放入摘要时使用 `previewOmitted: true`；精确数据通过 query 分页读取。完整快照仅用于当前实例内部的冲突检查，不复制到模型上下文。文件资源令牌和写入 ETag 不进入摘要。

每个编辑器仅保留最近 8 个内容戳。重新打开内容、切换文档或关闭实例使旧戳失效；同名文档、同一文件的另一个实例不能互借内容戳。仅持久化 revision 相同仍可能存在未保存手改，因此 apply 必须使用当前实例新读出的戳。
实时工具从提交输入前开始暂时锁定画布，覆盖异步计算、读取、应用和发送前同步，结束后恢复原可编辑状态。文档切换在离开确认到加载完成之间也保持锁定。保存等待期间允许继续编辑，返回后重新提交输入并比较完整数据；新增修改保留为未保存，保存副本不以旧内容替换当前实例。

### 当前修改

两个 apply 工具的参数结构一致：

```json
{
  "operationId": "caller-generated-unique-id",
  "documentId": "snapshot 返回的文档 ID",
  "baseContentStamp": "snapshot 返回的 UUID",
  "patch": {}
}
```

Univer 的 patch 是 `{ "sheetId": "sheet1", "cells": [{ "row": 1, "column": 1, "value": 120 }] }`。行列从零开始，每项只能指定 `value` 或以 `=` 开头的 `formula`；一次最多 1000 个不重复单元格，均在现有工作表范围内。一条稀疏命令保留其它单元格与样式，可以一次撤销；只读文件拒绝修改。

也支持 `patch: { "operation": { … } }`，与原写法二选一。通过公开原生命令执行一次样式、工作表、行列、冻结、合并清除、排序或筛选范围操作，公式引用由同版本引擎维护。保存工具与当前实例使用相同 schema 和无界面引擎预检；预检不写库，修改前仍重验原实例及内容戳。`spreadsheet_inspect` 提供实际操作规范、解析后的样式及结构摘要。共享公式在副本中展开，保留原生编辑器和撤销历史。源 XLSX 的结构及规则写回继续明确拒绝；完整契约与交换格式限制见 Univer 详细说明。

Perspective 的 patch 支持 `{ "panelId": "overview", "config": { "group_by": ["部门"], "columns": ["金额"], "aggregates": { "金额": "sum" } } }`。未提供配置保留，数组替换对应设置。`workspace` 可管理最多 8 个同源面板、拆分/标签布局、当前面板、主图点击联动、全局过滤及共享配色；显式 `panels` 替换完整面板集，其余变更保留现有面板。`cells`、`append`、`rows` 可修改现有类型的源记录。先预检整个工作区，再更新同一 viewer；当前文件不写回。完整契约见插件详细说明。

成功返回 `{ "operationId": "…", "status": "applied", "snapshot": { … } }`，表示当前编辑器已经应用。修改仍为未保存状态，需要主动保存到文档库或经批准写回源文件。冲突、不可编辑、关闭或未知结果返回 `isError: true`；每个实例最多接受 128 个操作 ID，保留期间同一 ID 不能再次执行。派发后响应丢失也不能重放，先读取当前内容核对结果。

调用方使用宿主已准入的确切 AppBridge 和当前会话权限选择目标；插件不从标题、位置、最后消息或 App 自报 JSON 取得授权。这里不新增 Gateway 编辑路由，不假造原生 run、toolCallId、viewId 或历史回执。

### 保存当前内容

两个 App 的 save 接受 `operationId`、`documentId`、`baseContentStamp` 及 `mode: document/copy`（默认 `document`）。在提交输入的短暂锁内重新验证完整内容戳，再使用与界面相同的保存规则；网络等待期间允许继续手改，完成后新编辑仍为 dirty。返回 `status: saved/copied`、`savedDocument: { id, title, revision }` 和当前快照，两者可能指向不同 ID。已确认持久化后若当前快照读取失败，返回 `snapshotUnavailable: true`，不能误报写入失败或据此重复操作。

保存与 apply 共享当前实例的 128 个操作 ID 上限，dispatch 后未知结果不重放。本地保存使用 revision CAS；源文件仅接受显式 `copy` 保存为本地文档，既有源文件审批和 ETag 写回仍由界面流程处理。不用有界预览拼出完整文档覆盖保存。

### 文档库状态

手动入口首页提供文字新建、导入、格式说明和文档搜索。无当前文档时标题只读，保存、导出和重读禁用。返回文档库时清除上下文的活动目标，发送 `{ app, screen: 'library', activeDocument: null }`。后台摘要合并最新请求，和显式 prepare 共用串行发送通道；请求代次让迟到的旧描述失效。该信息仍只是上下文，不能充当宿主授权。

### 当前结果查询

`spreadsheet_query` 接收 `sheetId`、`startRow`、`startColumn`、`rowCount`、`columnCount`；默认 20×10，最大 100×20。结果包含实际范围、值和显式公式。它先提交正在编辑的单元格并等待公式计算。

`analysis_query` 接收可选 `panelId` 及行列窗口；默认 25×20，最大 100×20。查询当前实际筛选、点击联动、分组及聚合后的引擎 view，返回 `totalRows`、`totalColumns`、分页信息、`rows` 和是否还有更多行列。分组路径为引擎的 `__ROW_PATH__`，不要当成源数据字段。单次查询最多 256 KiB，超出时明确要求缩小窗口。`analysis_inspect` 可读取完整未保存工作区、源数据页、选区、离线图表角色与动态样式/计算规范；样式参考通过无持久化的服务端只读预检复用真实引擎，不建立第二套业务存储。
已保存的 `read_range` 和 `read_analysis` 同样按完整结构化结果限制为 256 KiB；后者的 `includeConfig: false` 可以省略大型配置，同时返回 `configOmitted: true`。行数上限不能替代 UTF-8 字节上限。

### 发送前准备

宿主从 App 工具发现 `_meta['workspace/prepare-context'] === true` 的 `prepare_context`，通过当前桥调用并等待完成。它只提交输入、生成有界内容并同步上下文，不保存、不创建文档、不执行 MCP 业务工具，也不发送消息。

缺少 text context 能力、当前编辑器未就绪、同步被拒绝、关闭或同步期间又发生手改时，准备失败。调用方保留原草稿并处理失败，不能把发出了异步通知视为准备完成。此 metadata 是可选集成约定，不是所有 MCP 客户端都会执行的行为。

## 恢复和集成边界

| 能力                   | 当前范围与后续验收                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| 已保存文档恢复         | SQLite 文档库及明确 ID，重启重新读取，不重放创建工具                                       |
| 未保存草稿、撤销栈     | 当前存活实例中保留；销毁或重启后不承诺恢复                                                 |
| 历史结果与实时引用     | 未实现按原生 transcript 恢复、内容关联或持久 ACK；需要时由接入方与插件共同定义可验证的适配 |
| 模型发送的当前目标路由 | 已提供标准 App 工具；原生会话、确切实例与实际 run 的选择及权限验证由接入方负责             |
| 文件写回               | Univer 沿用现有认证、审批、ETag、备份和原子替换接口；Perspective 文件仅探索和保存文档副本  |
| Excel 与大数据兼容     | 保留各插件已声明的容量和格式限制，不承诺全部 Excel 功能或远程分析后端                      |

独立验证覆盖真实 stdio、标准 AppBridge 与离线浏览器。安装到目标环境后的导入、启停、文件授权、发送目标与会话隔离仍须完成匹配版本的原生集成验收，方法见[测试与验收](testing.md)。插件详细使用说明以 [Univer](../plugins/extensions/univer/README.md) 和 [Perspective](../plugins/extensions/perspective/README.md) 为准。
