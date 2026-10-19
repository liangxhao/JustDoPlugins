# OpenClaw Extensions

面向 OpenClaw 独立开发和分发的原生扩展集合。每个插件附带 MCP App，可独立安装、启停与交付；源码、依赖和交付包由本仓库统一管理。

## 当前插件

| 插件        | 主要用途                         | 详细文档                                          |
| ----------- | -------------------------------- | ------------------------------------------------- |
| Univer      | 离线表格编辑、文件预览与导入导出 | [Univer](docs/plugins/univer/README.md)           |
| Perspective | 离线数据透视、分组筛选与图表     | [Perspective](docs/plugins/perspective/README.md) |

完整清单与能力对比见[当前插件列表](docs/plugins/README.md)。

## 文档入口

- [文档导航](docs/README.md)
- [安装与使用](docs/guides/install-and-use.md)
- [开发指南](docs/development/README.md)
- [离线构建与交付](docs/development/offline-delivery.md)

## 仓库概览

| 目录       | 用途                                       |
| ---------- | ------------------------------------------ |
| `plugins/` | 各插件的源码、包信息与原生清单             |
| `shared/`  | 共用协议、服务与界面实现                   |
| `scripts/` | 检查、构建与打包                           |
| `tests/`   | 自动测试与浏览器验证                       |
| `docs/`    | 使用、开发与插件详细文档                   |
| `dist/`    | 本地生成的独立插件和压缩包，不纳入版本控制 |

主要开发在 `dev` 分支进行，`main` 暂仅保留仓库简介。
能力边界、兼容性、依赖与验收要求统一见对应文档。
