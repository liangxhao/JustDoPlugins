# Extensions 原生扩展

本目录收录通过 OpenClaw 原生扩展机制安装的插件。当前两个扩展均附带 stdio MCP 服务及 MCP App，这些能力随扩展维护。下表描述当前实现的范围，宿主内集成仍需在匹配版本中按开发文档验收。

| 插件                                 | 扩展 ID           | MCP 服务      | 版本  | 用途                           |
| ------------------------------------ | ----------------- | ------------- | ----- | ------------------------------ |
| [Univer](univer/README.md)           | `univer-app`      | `univer`      | 0.1.0 | 表格编辑、文件预览与源文件写回 |
| [Perspective](perspective/README.md) | `perspective-app` | `perspective` | 0.1.0 | 14 种离线视图、多面板与点击联动；[覆盖边界](perspective/README.md#图表覆盖与上游边界) |

## 能力对比

| 能力                           | Univer                      | Perspective                  |
| ------------------------------ | --------------------------- | ---------------------------- |
| 导入                           | XLSX、CSV、TSV、工作簿 JSON | CSV、TSV、JSON、NDJSON、Arrow |
| 导出                           | 多工作表 XLSX               | CSV、PNG、JSON、NDJSON、Arrow、静态 HTML、完整分析文档 |
| 编辑或分析                     | 单元格、公式、基础格式      | 14 种视图、表达式、窗口、多面板及点击联动 |
| 工作区文件预览与源文件写回     | 预览、授权写回及保存副本    | 只读预览及保存文档副本       |
| 本地文档与版本冲突检查         | 支持                        | 支持                         |
| 发送前准备与当前内容读取       | 提交输入、等待同步、范围查询 | 等待同步、当前聚合结果查询   |
| 当前实例连续修改               | 按内容戳修改，一次撤销       | 按内容戳修改配置、工作区及源记录 |
| 图标与原生技能                 | 随扩展提供                  | 随扩展提供                   |
| 单行共享标题栏                 | 支持，协商失败恢复独立布局   | 支持，协商失败恢复独立布局    |
| 持久化文档上限                 | 8 MiB                       | 2 MiB                        |

具体容量、格式兼容性、MCP 工具和未支持能力见各插件详细文档，不能将上游产品的全部能力视为本扩展已经支持。
两层接口及补齐范围见[能力审查](../../development/app-capabilities.md)。

## 后续开发方向

[官方 MCP App 选型与离线开发路线](../../development/mcp-app-roadmap.md)优先选择产品维护者已提供 App 的工程工具，区分官方支持、近期发布、离线资源与内网服务依赖。当前优先比较 Flint/Unovis 工程图表、LikeC4 架构模型和 Grafana 指标与追踪 App；候选完成本仓适配和交付验收后再加入插件列表。

## 源码与交付

| 插件        | 源码（相对仓库根目录） | 生成的独立导入目录（相对仓库根目录） |
| ----------- | ---------------------- | ------------------------------------ |
| Univer      | `plugins/extensions/univer/`      | `dist/plugins/extensions/univer/`               |
| Perspective | `plugins/extensions/perspective/` | `dist/plugins/extensions/perspective/`          |

压缩包与 `SHA256SUMS` 位于 `dist/archives/extensions/`，版本来自插件包信息。
安装方式见[安装与使用](../../guides/install-and-use.md)，交付流程见[离线构建与交付](../../development/offline-delivery.md)。全部类型见[插件分类与列表](../README.md)。
