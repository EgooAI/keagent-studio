# 抖音视频发布迁移

实现位置为 `codex/douyin-publish` worktree。迁移来源为 AutoUp-On `510132af0462a2bccd421ae264a7edab3a393982`。本轮提供已验收成片的单视频、单账号立即发布，用户可维护多个账号；没有图文、排期和用户任务管理页。消费边界继续遵循第12章，旧 Workspace 发布任务和演示结果不转换为真实发布记录。

## 用户端

真实发布中心从 ArtifactExchange 列出成片，显示验收与设备资产状态。成片详情接收固定交接，再编辑抖音标题、正文、话题和封面。标题最多30个 UTF-16 单元，正文与话题合计最多1000，超限提示修改，不截断。默认公开、禁用下载、不同步头条，高级参数不开放。

设置中的抖音账号支持添加、登录、保存、检查、重登和解绑。账号使用内置 WebContentsView 与持久化 Session，统一跟随系统网络。用户可在账号标签和工作台之间切换。发布过程留在 Main，页面切换不重复或停止发布。每台设备仅执行一次发布；同一成片、账号的未知结果未核对前不能再次提交。

成片详情保留进度、作品引用和按20条分页的发布记录。accepted 显示“已提交抖音”；人工核对记录单独标注。网页版可以查看数据，真实文件、登录和发布由桌面客户端完成。原演示通过独立“查看原演示”入口保留。

## 接口与数据

新增 `DouyinAccount / DouyinPublishInput / DouyinPublishRecord / DouyinDesktopState`，不修改共享成片类型。用户业务接口位于 `/v1/douyin/`，统一为认证 POST：

| 操作 | 用途 |
| --- | --- |
| `accounts/list / bind / update / unbind` | 设备账号引用和安全登录状态；登录资料不上传 |
| `records/create / get / list` | 固定交接的发布尝试、幂等创建与分页读取 |
| `records/report / heartbeat` | 当前设备执行阶段、回执和安全步骤回报 |
| `records/reconcile` | 原设备用户明确记录未知结果的核对结论 |

云端新增独立发布表、账号表、流程健康、幂等观察与邮件队列，启动自动迁移。并发设备锁、请求键、归属与状态转移校验防止重复执行。平台发布业务不改写源成片内容；成片验收仅通过现有共享验收接口由用户明确操作。

发布步骤日志仅包含固定步骤名、状态、时间、耗时和错误码。不向管理员返回平台正文、替换封面令牌、本地路径、Cookie、STS或完整平台响应。

## 管理员端与告警

`/admin/douyin` 提供只读报表、按用户/设备/时间/状态/错误码筛选、步骤日志和流程健康。管理员不能代用户登录、发布或重试。

告警按抖音短视频立即发布计算：24小时内连续3次 EXECUTION_FAILED 触发一次异常通知，之后首次平台自动回执成功触发一次恢复通知。登录、内容预检、文件、验收、人工核对、未知结果和取消不计入。SMTP已接收但数据库尚未标记成功的罕见中断可能重复发送邮件。

管理员维护一个全局运维邮箱；留空关闭发送。SMTP使用服务端环境配置：

```dotenv
DOUYIN_SMTP_HOST=
DOUYIN_SMTP_PORT=587
DOUYIN_SMTP_USERNAME=
DOUYIN_SMTP_PASSWORD=
DOUYIN_SMTP_FROM=
DOUYIN_SMTP_TLS=starttls
```

TLS支持 `starttls / implicit / none`；none用于本机SMTP测试。凭证不通过管理API返回。邮件队列持久化，失败5分钟后重试；SMTP缺项时界面明确提示，发布本身仍可使用。

## 验证与联调

执行仓库 lint、Vitest、build 和 Go test/vet；`ADMIN_TEST_DATABASE_URL` 指向允许创建临时schema的测试库，数据库测试不应以跳过代替通过。

```powershell
corepack pnpm exec playwright test --config playwright.douyin.config.ts
node scripts/douyin-electron-integration.mjs
```

额外覆盖固定交接、验收变化、文件哈希、账号隔离、请求重放、单次提交、中断恢复、管理员只读、告警去重及本机SMTP投递。隐藏Electron和页面夹具均不触发真实平台副作用。

Windows目录包通过独立暂存目录构建：暂存中仅包含桌面静态资源、Main/Preload和发布运行时，不收集同仓库的后台依赖。`beforeBuild`检查暂存依赖为空后跳过工作区依赖收集。当前系统已安装匹配版本Electron时，可复用其分发文件：

```powershell
corepack pnpm package:desktop --config.electronDist=node_modules/electron/dist
node scripts/douyin-package-smoke.mjs
```

`electronDist`复用只用于当前系统/架构；跨平台构建应使用相应平台分发文件或默认下载流程。生成目录为 `release/win-unpacked`，本轮验证的是未签名目录包，不是签名安装器。打包启动检查使用独立临时用户目录，不读取已有登录资料。

当前已验证：lint、82个Vitest测试、7个抖音页面场景、6个原演示工作流回归、桌面和管理员构建、Go test/vet、Windows目录包构建及隔离启动均通过。另通过真实文件探测、本机注册器、真实 Go API/PostgreSQL 与隐藏 Electron 的交接链路，数据库使用临时独立schema并清理。平台请求均被拦截，不能视为真实发布验收。

## 真实成片接通

默认 Main 已创建 `artifact-media` 本机注册表并注入发布器。当前全景制作通过自身的显式完成结果端口提供 MP4 和封面；未完成任务、其他用户任务和示例成果均拒绝登记。发布器不读取制作检查点。注册器保存独立副本，探测真实媒体，并绑定用户、设备、资产 ID、不透明令牌、大小及 SHA-256。同来源版本重放返回原成果，不重置验收。

用户操作：真实制作完成 → 结果页“登记成片到发布中心” → 验证文件并预览 → 明确“验收通过” → 接收 → 选择抖音账号并立即发布。丢失文件可在详情页定位完全相同的原文件，哈希不一致会拒绝；恢复文件不改变验收。FFprobe 需在 PATH 或配置 `FFPROBE_PATH`，与现有制作环境共用。

真实发布、平台审核与当前接口兼容性尚未用授权抖音测试账号验证。运行应用仍需配置真实认证和后端连接；自动测试通过不能替代账号登录与平台发布联调。模块入口与扩展方法见 [本机成片注册与解析](../apps/desktop/electron/artifact-media/README.md)。
