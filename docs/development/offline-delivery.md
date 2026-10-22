# 离线构建与交付

本文覆盖 `plugins/extensions/` 中已注册 MCP App 的原生扩展。其他类型的独立插件尚未提供构建与打包流程，分类见[插件分类与列表](../plugins/README.md)。

## 准备条件

准备机使用 Node 24.16.0 及以上的 24.x 版本。依赖精确版本、下载地址与完整性由根目录 `package-lock.json` 锁定。
下载使用 npm registry `https://registry.npmjs.org/`，内网环境可使用已经准备好对应版本的镜像或缓存。

类型检查需要 OpenClaw 2026.10.4 的公开 SDK 声明。默认读取 `node_modules/openclaw/dist/plugin-sdk`；
如果 SDK 在其他位置，在执行命令前设置 `OPENCLAW_SDK_ROOT` 指向实际的 `dist/plugin-sdk` 目录。
脚本不会自动下载 OpenClaw。App 规范测试、界面验证及打包前检查均需要准备机已安装 Chrome，不会在测试时下载或因缺失而跳过。

## 构建流程

从仓库根目录执行：

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm run build
npm test
npm run test:ui
npm run pack:apps
```

首次准备依赖需要可访问所配置的 registry，或者已有完整的 npm 缓存；离线运行不等于准备机首次安装依赖也无需下载。
构建和运行均不依赖宿主源码。
App 列表由仓库注册自动发现；`npm test` 包含 App 规范检查，`npm run pack:apps` 打包前再次执行该检查。源码指纹或产物哈希不匹配时须重新构建，不能交付旧产物。

## 产物目录

| 路径（相对仓库根目录） | 用途                                                     |
| ---------------------- | -------------------------------------------------------- |
| `plugins/extensions/<name>/dist/` | 单个扩展的编译产物，包括静态页面、服务、完整性清单与许可 |
| `dist/plugins/extensions/<name>/` | 干净的扩展交付目录，可直接导入                           |
| `dist/archives/extensions/`       | 每个扩展的 `.tgz` 压缩包与 `SHA256SUMS`                  |

当前压缩包为 `local-mcp-univer-app-0.1.0.tgz` 和 `local-mcp-perspective-app-0.1.0.tgz`。
包名和版本取自各插件的 `package.json`，升级版本后文件名随之变化。

每个交付目录包含包信息、原生清单、必要的扩展入口、完整 `dist/`，以及从 `docs/plugins/extensions/<name>/README.md` 复制的详细使用说明。
JS、CSS、WASM 和字体内嵌于 `dist/app.html`；`dist/server.cjs` 是无 npm 运行依赖的 stdio 服务。
`dist/licenses/` 和 `dist/THIRD_PARTY_NOTICES.json` 按实际打包依赖及其版本保留第三方许可。

交付包不含开发依赖、公共源码、测试或仓库专用的 `mcpApp` 注册字段，复制到另一台机器后仍可独立导入。
运行使用宿主提供的 Node 24，不使用 `npx`、不访问 registry、不执行安装脚本或首次启动资源下载。

## 分发与安装

使用[Extensions 列表](../plugins/extensions/README.md)选择需要的扩展，将对应的交付目录或压缩包带入目标环境。
原生清单声明附带 MCP，由 OpenClaw 管理相对安装路径、服务启停和进程；分发时使用 `extension` 类型。
安装后的使用方法见[安装与使用](../guides/install-and-use.md)。本仓库不提供自动上架 Provider。

启动时核对服务器和 HTML 的 SHA-256 清单，用于检测不完整或被修改的资源。
分发方仍需对整个交付包提供可信哈希或签名，包内清单不能充当来源认证。
`SHA256SUMS` 可用于核对传输前后的压缩包是否一致。

卸载扩展不自动删除用户文档；备份时先停用服务，再复制整个数据目录，包括 SQLite WAL。
数据位置和并发约定见[架构与隔离边界](architecture.md)，插件特有的数据与能力限制见各插件详细文档。
发布前还需完成[宿主集成验收](testing.md)。
