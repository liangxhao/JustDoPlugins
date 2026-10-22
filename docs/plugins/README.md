# 插件分类与列表

插件按独立安装与交付单元分为四类，源码和详细文档使用相同的类型与名称。

| 类型 | 范围 | 源码（相对仓库根目录） | 当前实现 |
| ---- | ---- | ---------------------- | -------- |
| [extensions](extensions/README.md) | OpenClaw 原生扩展，可附带 MCP 服务、MCP App、Skill 或 Hook | `plugins/extensions/<name>/` | Univer、Perspective |
| [skills](skills/README.md) | 独立分发的技能说明及配套资源 | `plugins/skills/<name>/` | 暂无 |
| [mcp-servers](mcp-servers/README.md) | 独立配置与运行的 MCP 服务 | `plugins/mcp-servers/<name>/` | 暂无 |
| [hooks](hooks/README.md) | 独立分发的事件钩子 | `plugins/hooks/<name>/` | 暂无 |

当前两个插件通过原生扩展安装，因此归入 extensions；它们内含的 MCP 服务和 MCP App 仍属于各自扩展，不另算独立 MCP 服务。
两个扩展附带的任务 Skill 同样随所属扩展交付，不列为独立 skills 插件。

后续工程工具扩展优先复用产品官方已有的 MCP App，并验证完整离线交付，选型与顺序见[官方 MCP App 选型与离线开发路线](../development/mcp-app-roadmap.md)。其中的上游候选不计入当前实现。

每类列表由 `docs/plugins/<type>/README.md` 维护，各插件详细说明统一位于 `docs/plugins/<type>/<name>/README.md`。新增插件时同步更新对应类型列表与[文档导航](../README.md)。

交付产物按类型输出到 `dist/plugins/<type>/<name>/` 和 `dist/archives/<type>/`。当前构建、App 规范测试和打包流程覆盖 extensions 中的注册 App；其余类型尚未提供专用构建与打包流程。
