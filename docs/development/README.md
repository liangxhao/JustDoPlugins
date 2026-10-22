# 开发指南

本仓库使用 npm workspaces 管理独立 OpenClaw 扩展。以下路径以仓库根目录为基准，所有命令从根目录执行。

## 环境准备

- Node 24.16.0 及以上的 24.x 版本，版本选择见根目录的 `.nvmrc`。
- 依赖版本由根目录 `package-lock.json` 锁定，使用 `npm ci` 安装。
- 类型检查需要 OpenClaw 2026.10.4 的公开 SDK 声明；默认使用 `node_modules/openclaw/dist/plugin-sdk`，也可通过 `OPENCLAW_SDK_ROOT` 指向实际的 `dist/plugin-sdk` 目录。
- SDK 不随本仓库依赖自动安装，只用于开发类型检查，不复制到插件交付包。
- 浏览器验证使用已安装的 Chrome，不在测试启动时下载浏览器。

运行、构建和打包不依赖宿主源码或固定的宿主目录。准备与离线交付步骤见[离线构建与交付](offline-delivery.md)。

普通扩展无需实现交互界面。需要 MCP App 时，先按[MCP App 开发与宿主接入](mcp-app-development.md)选择能力，再用[接入 checklist](mcp-app-checklist.md)核对身份来源、界面显示及所选入口。

## 目录与开发流程

```text
openclaw-extensions/
├── plugins/                 # 插件源码；每个目录是一个 npm workspace
│   ├── univer/              # 表格编辑、文件预览与写回
│   └── perspective/         # 数据透视与图表
├── shared/                  # 两个插件共用的协议、服务与界面实现
├── scripts/                 # 类型检查、构建、打包入口
├── tests/                   # 自动测试、浏览器验证及测试宿主
├── docs/                    # 文档导航、开发指南和插件详细说明
├── dist/                    # 生成的交付产物（不提交）
│   ├── plugins/             # 可直接导入的独立插件目录
│   └── archives/            # 压缩包与校验和
└── test-results/ui/         # 浏览器截图与验证报告（不提交）
```

每个插件的包信息、原生清单、扩展入口和业务源码集中放在自己的目录中；
构建结果位于对应的 `plugins/<name>/dist/`，由打包脚本复制到交付目录。
根目录统一管理依赖锁、TypeScript 和格式配置，不在各插件中维护独立 lockfile。
本地代理工作记录 `.agent-tasks/` 不属于源码，不纳入版本控制。

开发命令从仓库根目录运行：

```sh
npm ci
npm run check
npm run build
npm test
npm run test:ui
npm run pack:apps
```

单独构建可运行 `npm run build -- univer` 或 `npm run build -- perspective`。
测试和打包需要先构建；修改源码后应重新构建再验证。
离线依赖准备和 SDK 设置见 [离线准备](offline-delivery.md)。

新增插件时，在 `plugins/<name>/` 中添加包信息、清单、入口与说明。
带有 `app.ts` 的插件必须在包信息中注册 `mcpApp.contractVersion: 1`，实现本仓库的共享标题栏规范。
构建、App 规范测试和打包自动发现全部注册 App，无需另增插件名单；漏注册会报错。
`npm test` 包含该规范测试，也可运行 `npm run test:apps` 单独排查。业务专有能力仍需增加相应测试。
只有确实被多个插件使用的实现才放入 `shared/`。

日常开发在 `dev` 分支进行，
`main` 暂仅保留仓库简介。首次推送开发分支可执行 `git push -u origin dev`。源码和锁文件纳入版本控制，
依赖、构建产物、交付包和测试报告均由本地命令生成。

## 文档维护

根 `README.md` 仅介绍项目定位、总体结构和文档入口；文档导航位于 `docs/README.md`。
当前插件列表位于 `docs/plugins/README.md`，每个插件的详细说明统一维护在 `docs/plugins/<name>/README.md`。
插件源码目录的 README 只保留简介和文档链接；`npm run pack:apps` 会将对应的详细说明复制为交付包根 README，离线使用时无需访问源码仓库。

新增插件或更改行为时，同步更新插件列表、对应详细说明及受影响的开发指南。
实现中的公开接口、支持范围与限制应在插件文档中说明，避免在多个入口重复维护。

## 继续阅读

- [架构与隔离边界](architecture.md)：MCP Apps、数据存储、并发与离线资源。
- [MCP App 开发与宿主接入](mcp-app-development.md)：界面协议、身份与来源、入口元数据、稳定回执和可选恢复。
- [MCP App 接入 checklist](mcp-app-checklist.md)：区分必需项、按需项和真实宿主验收。
- [测试与验收](testing.md)：自动测试、浏览器验证、状态保留、历史投影与权限验收。
- [当前插件列表](../plugins/README.md)：插件身份、功能与文档入口。
