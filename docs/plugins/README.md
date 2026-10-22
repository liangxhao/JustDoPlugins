# 当前插件列表

每个插件都是独立 OpenClaw 原生扩展，附带 stdio MCP 服务及 MCP App。下表描述当前实现的范围，宿主内集成仍需在匹配版本中按开发文档验收。

| 插件                                 | 扩展 ID           | MCP 服务      | 版本  | 用途                           |
| ------------------------------------ | ----------------- | ------------- | ----- | ------------------------------ |
| [Univer](univer/README.md)           | `univer-app`      | `univer`      | 0.1.0 | 表格编辑、文件预览与源文件写回 |
| [Perspective](perspective/README.md) | `perspective-app` | `perspective` | 0.1.0 | 数据透视、分组、筛选与图表     |

## 能力对比

| 能力                           | Univer                      | Perspective                  |
| ------------------------------ | --------------------------- | ---------------------------- |
| 导入                           | XLSX、CSV、TSV、工作簿 JSON | CSV、JSON                    |
| 导出                           | 多工作表 XLSX               | 当前分析视图 CSV             |
| 编辑或分析                     | 单元格、公式、基础格式      | 透视、分组、筛选、聚合、图表 |
| 工作区文件预览与源文件写回     | 支持，受资源能力和授权约束  | 未提供                       |
| 本地文档与版本冲突检查         | 支持                        | 支持                         |
| 持久化文档上限                 | 8 MiB                       | 2 MiB                        |

具体容量、格式兼容性、MCP 工具和未支持能力见各插件详细文档，不能将上游产品的全部能力视为本扩展已经支持。

## 源码与交付

| 插件        | 源码（相对仓库根目录） | 生成的独立导入目录（相对仓库根目录） |
| ----------- | ---------------------- | ------------------------------------ |
| Univer      | `plugins/univer/`      | `dist/plugins/univer/`               |
| Perspective | `plugins/perspective/` | `dist/plugins/perspective/`          |

压缩包与 `SHA256SUMS` 位于 `dist/archives/`，版本来自插件包信息。
安装方式见[安装与使用](../guides/install-and-use.md)，交付流程见[离线构建与交付](../development/offline-delivery.md)。
