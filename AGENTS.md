# 项目约定

## 定位与命名

- 本仓库开发独立的 OpenClaw 原生扩展，每个扩展可附带 MCP App。
- 文档、代码、包元数据及 Git 提交信息统一使用 OpenClaw 扩展或通用插件表述，不使用具体下游应用的产品名称。
- 不依赖特定下游宿主的源码、安装包、内部补丁或固定目录结构。接入能力以匹配版本的 OpenClaw 公开 SDK 和扩展协议为准。
- 文档中的路径以仓库根目录为基准，使用相对路径；本机 SDK 位置通过 `OPENCLAW_SDK_ROOT` 配置，不写入源码或文档示例。
- 产物命名使用通用插件术语，不引入市场名称。

## 分支与目录

- `main` 暂仅保留简要 README；主要开发在 `dev` 分支进行。
- 插件源码位于 `plugins/<name>/`，公共实现位于 `shared/`，构建脚本位于 `scripts/`，测试位于 `tests/`。
- 独立导入目录输出到 `dist/plugins/`，压缩包与校验和输出到 `dist/archives/`，浏览器验证报告输出到 `test-results/ui/`。
- 不提交依赖目录、构建产物、交付包、本地配置或代理工作记录。

## 文档结构

- 根 `README.md` 只描述项目定位、总体结构和文档入口，不承载单个插件的使用或实现细节。
- `docs/README.md` 是文档导航；`docs/development/` 保存开发、架构、测试及交付指南，`docs/guides/` 保存通用使用说明。
- `docs/plugins/README.md` 维护当前插件列表，`docs/plugins/<name>/README.md` 是各插件详细说明的唯一维护源。
- 插件源码目录的 README 仅保留简介与导航；打包脚本将对应的详细说明复制为交付包 README。详细说明需能独立阅读，不能依赖交付包之外的仓库链接。
- 新增插件或变更能力时，同步更新文档导航、插件列表和受影响的详细说明。
- 开发指导只记录插件能力、公开协议和必要的集成约束；宿主菜单、侧栏布局、Tab 路由、窗口实现与内部验收由宿主工程维护，不写成插件职责。
- 涉及 MCP App 时，先读 [MCP App 开发与宿主接入](docs/development/mcp-app-development.md)，按 [接入 checklist](docs/development/mcp-app-checklist.md) 验证必需项和所选能力；普通插件无需实现 App 界面或入口。

## 验证

- 从仓库根目录运行开发命令，使用 Node 24.16.0 及以上的 24.x 版本和根目录的 npm 锁文件。
- 类型检查默认使用 `node_modules/openclaw/dist/plugin-sdk`；SDK 位于其他位置时，显式设置 `OPENCLAW_SDK_ROOT`。
- 修改源码后先构建，再运行相关自动测试；涉及界面或交付路径时运行浏览器验证或重新打包。
- 发布前由接入方在匹配版本的 OpenClaw 环境中验证导入、启停、文件预览、保存及权限边界；独立测试不能替代宿主集成验收。
