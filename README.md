# OpenClaw Plugins

面向 OpenClaw 的插件仓库，按 `extensions`、`skills`、`mcp-servers`、`hooks` 四类管理源码、依赖、文档和交付产物。

## 插件分类

| 类型 | 源码目录 | 文档入口 |
| ---- | -------- | -------- |
| extensions | `plugins/extensions/` | [原生扩展](docs/plugins/extensions/README.md) |
| skills | `plugins/skills/` | [技能](docs/plugins/skills/README.md) |
| mcp-servers | `plugins/mcp-servers/` | [独立 MCP 服务](docs/plugins/mcp-servers/README.md) |
| hooks | `plugins/hooks/` | [事件钩子](docs/plugins/hooks/README.md) |

当前实现均属于 extensions，其余三类预留目录。分类依据为独立安装与交付单元；扩展附带的 MCP 服务和 MCP App 随扩展维护。完整清单见[插件分类与列表](docs/plugins/README.md)。

## 文档入口

- [文档导航](docs/README.md)
- [安装与使用](docs/guides/install-and-use.md)
- [开发指南](docs/development/README.md)
- [MCP App 接入与验收](docs/development/mcp-app-development.md)
- [离线构建与交付](docs/development/offline-delivery.md)

## 仓库概览

| 目录       | 用途                                       |
| ---------- | ------------------------------------------ |
| `plugins/` | 按类型组织的插件源码与元数据               |
| `shared/`  | 共用协议、服务与界面实现                   |
| `scripts/` | 检查、构建与打包                           |
| `tests/`   | 自动测试与浏览器验证                       |
| `docs/`    | 使用、开发与插件详细文档                   |
| `dist/`    | 本地生成的独立插件和压缩包，不纳入版本控制 |

主要开发在 `dev` 分支进行，`main` 暂仅保留仓库简介。
能力边界、兼容性、依赖与验收要求统一见对应文档。
