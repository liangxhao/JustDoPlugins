# 文档导航

本目录按通用使用、开发维护和插件详情组织文档。根 README 只保留项目概览；插件的功能、工具和限制以各自的详细文档为准。

## 使用扩展

| 文档                                         | 内容                                           |
| -------------------------------------------- | ---------------------------------------------- |
| [当前插件列表](plugins/README.md)            | 插件身份、能力对比、交付目录和详细文档入口     |
| [安装与使用](guides/install-and-use.md)      | 安装、启停、打开应用、本地文档与常见问题       |
| [Univer](plugins/univer/README.md)           | 表格编辑、文件预览、源文件保存、MCP 工具与限制 |
| [Perspective](plugins/perspective/README.md) | 数据导入、分析视图、MCP 工具与限制             |

## 开发与交付

| 文档                                                         | 内容                                                 |
| ------------------------------------------------------------ | ---------------------------------------------------- |
| [开发指南](development/README.md)                            | 环境、SDK、目录职责、开发命令、分支和新增插件        |
| [MCP App 开发与宿主接入](development/mcp-app-development.md) | 必需与可选能力、身份来源、界面协议、稳定回执和恢复   |
| [MCP App 接入 checklist](development/mcp-app-checklist.md)   | 必需项、按需功能及真实宿主交付验收                   |
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
│   ├── mcp-app-development.md
│   ├── mcp-app-checklist.md
│   ├── testing.md
│   └── offline-delivery.md
└── plugins/
    ├── README.md
    ├── univer/
    │   └── README.md
    └── perspective/
        └── README.md
```

新增插件时，在 `plugins/` 下增加独立的文档目录，并同步更新插件列表和本页入口。源码目录 README 只提供导航；交付包 README 从对应详细文档生成。
