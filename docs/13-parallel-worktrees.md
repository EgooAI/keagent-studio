# 两个 worktree 的并行开发准备

本次只提交公共交接基础与任务说明，不创建 worktree，也不实现视频生成或抖音发布逻辑。两个后续分支应从同一个已推送的公共基础提交开始。

## 建立分支

在原仓库中将 `<公共基础提交>` 替换为本次交付的完整提交 SHA，然后执行：

```powershell
git worktree add -b codex/video-production ../keagent-studio-production <公共基础提交>
git worktree add -b codex/douyin-publish ../keagent-studio-douyin <公共基础提交>
```

如果分支或路径已经存在，先检查 `git worktree list` 和该分支状态，不覆盖已有工作。两侧分别阅读 [制作任务说明](worktrees/video-production.md) 和 [抖音发布任务说明](worktrees/douyin-publishing.md)。共享语义以 [成片交接契约](12-artifact-exchange.md) 为准；旧文档中的生产任务/发布耦合描述不适用于新接口。

## 隔离开发环境

- 在每个 worktree 执行 `corepack pnpm install --frozen-lockfile`。`node_modules`、`.env.local`、`output` 和 Electron 用户目录不由 Git 自动复制。
- 分别准备私有 `.env.local`；不要提交密钥。原仓库 `output/tools` 中的 Go、FFmpeg 等工具可通过绝对路径或进程 PATH 复用，数据库数据目录和可变输出不要共用。
- 使用独立开发数据库，例如 `keagent_production` 和 `keagent_douyin`，各自初始化认证和迁移。可以共用 PostgreSQL 实例，但不能在两个运行实例中同时改写同一套工作数据。
- 每侧使用独立的 Electron `--user-data-dir`、认证环境和测试文件目录。两个进程不能共用文件令牌映射、身份文件或任务检查点。
- 当前 `dev-local.ps1`、认证启动命令、Vite/Electron 开发地址与 IPC 信任源包含固定端口。直接复制配置并同时启动会冲突；只更改 Vite 端口也会导致 IPC 信任校验失败。最初可轮流启动桌面环境；要同时运行，先统一调整各自的启动地址、API、JWT、Origin 和信任源配置。公共交接提交不修改这些启动机制。

共享 API 需要重启 Go 服务后自动创建三张元数据表。测试的 `ADMIN_TEST_DATABASE_URL` 应指向允许创建/清理临时 schema 的本机测试库；未设置时 Go 会跳过数据库测试，不能把跳过视为数据库验证通过。

## 协作与合并

1. 冻结共享类型、SDK、HTTP 路径、错误码和 JSON 夹具。各侧优先增加自己的模块，避免同时大改公共入口文件。
2. 新生产内部字段只留在制作模块，新平台字段只留在消费模块。禁止为开发方便把完整生产任务或抖音 Token 塞进成片对象。
3. 若确需改契约，先提交一个双方共用的小变更，再分别同步同一个提交；不要在两个分支上独立演化契约。
4. 发布侧先用固定夹具独立开发；制作侧先用只读消费测试验证输出。合并联调时再接真实接口与本机文件解析器。
5. 公共基础验收是元数据登记、所有权、版本、验收及交接，不包含生成质量或抖音发布成功。
