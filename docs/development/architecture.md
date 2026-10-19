# 架构与隔离边界

## 扩展与 MCP App

每个插件是独立的 OpenClaw 原生扩展，通过 `openclaw.plugin.json` 声明附带的 stdio MCP 服务。
OpenClaw 管理相对安装路径、服务启动与停止；卸载或停用扩展会撤下相应的服务和应用入口。
业务工具由 MCP 服务提供，共享服务与界面代码集中在仓库的 `shared/` 目录。

应用前端编译为单个 `app.html`，服务编译为独立的 `server.cjs`。
交付包包含执行需要的静态资源，运行时不安装 npm 依赖；OpenClaw 扩展入口使用宿主提供的公开 SDK。
插件清单与扩展入口负责接入，模型调用和界面操作复用同一套 MCP 服务。

## 数据与并发

默认数据在用户目录 `.local-mcp-apps/univer/documents.sqlite` 和
`.local-mcp-apps/perspective/documents.sqlite`，可分别通过环境变量 `MCP_APP_DATA_DIR`
指定目录。这里保存应用文档，不保存聊天、模型凭据或原生执行状态。
文档库是当前用户的跨会话文件集合，并非当前对话的消息列表。

保存使用 SQLite 原子更新和 revision 比较；不同窗口或模型的旧版本保存会被拒绝，
不会覆盖较新数据。遇到冲突，先复制/导出尚未保存的内容，再按重新读取。
当前不自动合并或后台自动保存。工具结果打开文档时重新读取最新存储，重启服务后可继续打开。
持久化大小和数据规模限制由各插件分别定义，具体上限见插件详细文档。
打开界面的工具只返回文档标识和版本，App 再通过当前视图读取最新数据，避免把大工作簿重复保存在原生视图租约中。

## 离线与隔离

两个应用都通过标准 MCP Apps `ui://` 和 AppBridge 交互。`open_editor` 额外声明
原生支持的 App-only global 入口，用于“+”菜单；普通 MCP Apps 客户端仍可调用创建工具。

编辑器静态 JS、CSS、WASM、字体全部内嵌在交付文件中。MCP 子进程启动一个随机端口的
`127.0.0.1` 静态页面，URL 使用每次启动重新生成的随机路径，检查 Host 和精确路径，
不提供文件浏览、任意路径或公网代理。资源声明只放行这一个本机 frame origin。
该页面自己的 CSP 只允许内嵌脚本、Blob 模块/Worker 和 WASM，禁止网络连接和表单提交。
外层桥只在确切的父窗口与该编辑 frame 之间转发 JSON-RPC，不改变 OpenClaw 的 CSP。
原生 opaque 内容的后代 frame 同样具有 opaque origin，因此 App 内部 relay 允许该
精确子窗口的 `null` origin，并使用 opaque receiver 必需的通配 target；宿主通道保持精确 origin。
进程退出后本机静态服务关闭。该设计不需要运行时 patch。

应用选择会以有界上下文反馈给当前模型；是否内网推理由宿主模型配置决定。
上下文同步独立于文件读取和保存：后台视图被宿主拒绝同步时，不覆盖文件状态，也不重试业务工具。
本地文件仅通过用户选择、原生会话授权的文件资源或模型明确传入的数据进入工具，不开放任意本机文件路径读取。
外部网络受 CSP 阻止不等于所有上游功能都可离线，未支持的地图/外链不应作为市场能力宣传。

## 插件特有接口

Univer 的工作区文件授权、快照、备份、源文件写回与大小限制见 [Univer 详细文档](../plugins/univer/README.md)。
Perspective 的数据与视图配置约定见 [Perspective 详细文档](../plugins/perspective/README.md)。
这些能力不通过额外的 MCP 连接或特定宿主补丁实现。

相关验证步骤见[测试与验收](testing.md)。
