# Windows 本地开发环境

本机使用 Node.js 24、项目固定的 pnpm 10.33.3，以及 `output/tools` 中的 Go 1.25.4、PostgreSQL 18 和 FFmpeg。工具、数据库、日志和账号凭据均不进入 Git。

## 日常启动

在项目根目录执行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/dev-local.ps1
```

此命令启动项目独立数据库、认证服务、Go 业务服务、管理后台，以及 Vite + Electron 桌面窗口。只开发网页时添加 `-WebOnly`。Ctrl+C 停止本次启动的应用进程，数据库保留运行。

```powershell
powershell -ExecutionPolicy Bypass -File scripts/dev-local.ps1 -Action status
powershell -ExecutionPolicy Bypass -File scripts/dev-local.ps1 -Action stop-db
```

| 服务        | 地址                                    |
| ----------- | --------------------------------------- |
| 客户端网页  | http://127.0.0.1:5173                   |
| 管理后台    | http://127.0.0.1:5174/#/admin/dashboard |
| 认证        | http://127.0.0.1:18080                  |
| Go 业务 API | http://127.0.0.1:18081                  |
| PostgreSQL  | 127.0.0.1:55432 / keagent               |

## 配置和账号

`.env.local` 保存数据库连接、随机服务端密钥及本机开发账号配置。`output/local-accounts.json` 保存管理员与普通用户的登录信息。两者均已被 Git 忽略；账号持久化在本项目 `output/postgres` 数据库中。

管理员登录管理后台；普通用户登录客户端。统一使用 `127.0.0.1`，避免与 `localhost` 混用导致 Cookie 和 Origin 不一致。

AI 和火山供应商密钥需要在 `.env.local` 中填入自己的有效凭证并重启后端。未配置时可以登录、管理账号、维护房源，并使用 Windows 系统声音和本机 FFmpeg 的全景制作能力。

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
