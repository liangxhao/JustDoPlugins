# 文档导航

本目录按通用使用、开发维护和四类插件详情组织文档。根 README 只保留项目概览；插件的功能、工具和限制以各自的详细文档为准。

## 插件分类与使用

| 文档                                         | 内容                                           |
| -------------------------------------------- | ---------------------------------------------- |
| [插件分类与列表](plugins/README.md) | extensions、skills、mcp-servers、hooks 的分类与入口 |
| [Extensions 原生扩展](plugins/extensions/README.md) | 当前扩展、能力对比和交付目录 |
| [Skills 技能](plugins/skills/README.md) | 独立技能的目录约定，当前暂无实现 |
| [MCP Servers 独立服务](plugins/mcp-servers/README.md) | 独立 MCP 服务的目录约定，当前暂无实现 |
| [Hooks 事件钩子](plugins/hooks/README.md) | 独立钩子的目录约定，当前暂无实现 |
| [扩展安装与使用](guides/install-and-use.md) | 当前两个扩展的安装、启停、打开应用与本地文档 |
| [Univer](plugins/extensions/univer/README.md) | 表格编辑、文件预览、源文件保存、MCP 工具与限制 |
| [Perspective](plugins/extensions/perspective/README.md) | 数据导入、分析视图、MCP 工具与限制 |

## 开发与交付

| 文档                                                         | 内容                                                 |
| ------------------------------------------------------------ | ---------------------------------------------------- |
| [开发指南](development/README.md)                            | 环境、SDK、目录职责、开发命令、分支和新增插件        |
| [MCP App 开发与宿主接入](development/mcp-app-development.md) | 必需与可选能力、身份来源、共享标题栏、稳定回执和恢复 |
| [MCP App 接入 checklist](development/mcp-app-checklist.md)   | 必需项、按需功能及真实宿主交付验收                   |
| [MCP App 能力审查与接口约定](development/app-capabilities.md) | 两个插件的补齐项、当前内容接口、连续修改及接入边界 |
| [架构与隔离边界](development/architecture.md)                | 扩展与 MCP App、存储、并发和离线资源                 |
| [测试与验收](development/testing.md)                         | 自动测试、历史投影、权限和插件状态保留验收     |
| [离线构建与交付](development/offline-delivery.md)            | 依赖准备、构建、打包、许可和完整性校验               |

## 目录结构

```text
docs/
├── README.md
├── guides/
│   └── install-and-use.md
├── development/
│   ├── README.md
│   ├── architecture.md
│   ├── app-capabilities.md
│   ├── mcp-app-development.md
│   ├── mcp-app-checklist.md
│   ├── testing.md
│   └── offline-delivery.md
└── plugins/
    ├── README.md
    ├── extensions/
    │   ├── README.md
    │   ├── univer/README.md
    │   └── perspective/README.md
    ├── skills/README.md
    ├── mcp-servers/README.md
    └── hooks/README.md
```

新增插件时，在 `docs/plugins/<type>/<name>/` 下增加详细文档，并同步更新对应类型的插件列表和本页入口。源码目录 README 只提供导航；扩展交付包 README 从对应详细文档生成。以上路径以仓库根目录为基准。
