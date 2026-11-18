# Windows 本地开发环境

本机使用 Node.js 24、项目固定的 pnpm 10.33.3，本机 PostgreSQL 18 服务（5432），以及 Go 1.25.4 和 FFmpeg。工具、数据库、日志和账号凭据均不进入 Git。

## 日常启动

在项目根目录执行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/dev-local.ps1
```

请先确保本机 PostgreSQL 服务已启动。此命令连接 5432 上的 `keagent` 数据库，启动认证服务、Go 业务服务、管理后台，以及 Vite + Electron 桌面窗口。只开发网页时添加 `-WebOnly`。Ctrl+C 停止本次启动的应用进程，数据库保留运行。

```powershell
powershell -ExecutionPolicy Bypass -File scripts/dev-local.ps1 -Action status
```

| 服务        | 地址                                    |
| ----------- | --------------------------------------- |
| 客户端网页  | http://127.0.0.1:5173                   |
| 管理后台    | http://127.0.0.1:5174/#/admin/dashboard |
| 认证        | http://127.0.0.1:18080                  |
| Go 业务 API | http://127.0.0.1:18081                  |
| PostgreSQL  | 127.0.0.1:5432 / keagent                |

## 配置和账号

`.env.local` 保存数据库连接、随机服务端密钥及本机开发账号配置。`output/local-accounts.json` 保存管理员与普通用户的登录信息。两者均已被 Git 忽略；账号持久化在本机 5432 实例的 `keagent` 数据库中，应用使用独立 `keagent` 账号。启动脚本不会启停共享数据库服务。旧 `output/postgres` 和 `output/backups` 中的迁移备份保留用于回退。

管理员登录管理后台；普通用户登录客户端。统一使用 `127.0.0.1`，避免与 `localhost` 混用导致 Cookie 和 Origin 不一致。

文案、百炼语音和 MiniMax 可在管理后台「AI 服务 → 服务配置」中配置，也可用 `.env.local` 提供启动配置。百炼语音使用同一北京地域的 API Key 和业务空间 ID。未配置时可以登录、管理账号、维护房源及管理公共音色目录。独立开发样片脚本可以使用 Windows 系统声音验证 FFmpeg。

Vite 会热更新后台页面。修改 `services/cloud` 中的服务实现或供应商后，需要重启 Go 业务服务，再刷新管理后台。若后台提示「云端语音服务需要更新」，检查 `VITE_GO_API_URL` 指向的是新启动的服务。

## 依赖和检查

当前系统的默认 `pnpm` 可能与项目版本不同，使用 Corepack 执行项目指定版本：

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

Go 位于 `output/tools/go/bin/go.exe`。`corepack pnpm dev:cloud` 会自动优先使用本项目的 Go，无需修改系统 PATH。单独打开终端运行其他 Go 命令时，将此目录加入该终端的 PATH，或直接使用完整路径。`dev-local.ps1` 已为其启动的所有服务设置工具路径，并在没有现有 `GOPROXY` 时使用 `https://goproxy.cn,direct` 下载 Go 模块。

此环境已在当前机器初始化；新克隆仓库需要另外下载工具、初始化数据库、创建 `.env.local`，并运行 `corepack pnpm setup:auth`，不能仅运行启动脚本完成首次安装。
