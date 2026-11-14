# M1 评论观察

在桌面端「AI 获客 → 评论观察」选择已在本机保存的抖音账号，粘贴作品详情页地址，或作者主页中点开作品后的地址，点击「打开并核验作品」。作者主页地址使用唯一的数字 `modal_id` 作为候选作品 ID。两种输入都转换为 `https://www.douyin.com/video/<数字 ID>` 再导航和记录。用户可以查看当前执行、取消观察、重看本地记录。在 Mock 模式中，此页面只显示模式提示。

## 执行与核验

- `BrowserExecutionCoordinator` 在进入 Profile、登录检测和发布执行前按账号取得执行权。人工账号标签从打开到关闭、切换或返回工作台期间持有执行权，菜单或短暂遮挡不会释放它。后台按入队顺序运行，等候上限 30 秒。观察的总时限为 60 秒。发布沿用自己的提交边界和执行超时。
- `DouyinBrowser.observe` 校验当前用户及设备绑定，复用打开标签的 Session，或用现有 ProfileManager 打开同一持久化 Profile。独立的沙箱 BrowserView 使用离屏渲染，OpenCliPage 在导航后提供 1280 × 900 视口。结束、取消或退出时关闭观察视图。
- 观察检查账号已保存的登录状态，并使用同一 Session 下适用于作品站点的登录 Cookie 名称和有效期，或页面的登录账号标记。出现登录提示、验证或访问限制时立即停止。观察页面仅收到一个布尔值。
- 在隔离的 JS 世界中核对最终 URL、输入作品 ID、可见作品详情与作者资料链接。缺少详情 ID 属性时，需要规范链接精确指向该作品，且详情标题与文档标题一致。对应作者资料卡中不同链接必须指向同一作者。信号不足或矛盾时停止核验。
- 每次页面快照中先判定限制、作品和作者，再检查目标作品的评论面板。初始页面只做短时、只读的加载等待。不会自动展开评论、滚动加载、读取评论正文或调用评论接口。可见性反映本次视口及时间点。DOM 选择器集中在 `page-observer.ts`。
- 只在用户明确勾选本次截图授权、作品已核验且面板异常时捕获视口。保存前复核作品、作者和面板状态。验证码、访问限制和未确认身份均不保存截图。

## IPC 与数据

复用现有受信主窗口的 `douyin:request` 白名单、Preload 和 API Client。四个方法均在本机执行。

| IPC 方法 | API Client 方法 | 参数和返回 |
| --- | --- | --- |
| `observation.start` | `douyinApi.observe` | 账号 ID、标准链接、可选本次异常截图授权，返回初始记录 |
| `observation.list` | `douyinApi.observations` | 返回当前用户及设备的本地历史，按开始时间倒序 |
| `observation.cancel` | `douyinApi.cancelObservation` | 观察记录 ID，终态可从历史读取 |
| `observation.screenshot` | `douyinApi.observationScreenshot` | 有截图的本机记录 ID，返回 PNG 数据 URL |

记录位于 `userData/douyin/<用户与设备的哈希>/comment-observation/`。每次观察一个 JSON，截图使用同一随机记录 ID。JSON 使用原子替换，包含账号与设备 ID、规范目标链接、输入和已核验 ID、作者、作品标题、执行和面板状态、起止时间、错误码、原因及截图标记。无效输入仅记录失败原因，以免把用户粘贴的凭据写入磁盘。发现上次退出遗留的排队或运行记录时标记为 `INTERRUPTED`，结束时间为发现中断的时间。

执行状态为 `queued / running / finished / stopped`。

| 面板状态 | 判定 |
| --- | --- |
| `not_checked` | 尚未观察或作品身份核验未通过 |
| `visible` | 已核验作品的评论面板可见 |
| `explicitly_empty` | 作品面板明确显示空态提示 |
| `not_visible` | 当前作品的已知面板未显示在视口内，或其评论入口明确收起 |
| `loading` | 面板仍显示加载状态 |
| `load_failed` | 面板明确显示加载错误 |
| `restricted` | 账号、页面或面板要求登录、验证或限制访问 |
| `unknown` | 面板标记、归属或状态信号不足或冲突 |

## 验收

单元用例在 `observation.test.ts`。运行 `pnpm test` 检查链接、排队互斥、取消、等待超时和中断记录恢复；运行 `pnpm build:publishing` 后用 `node scripts/douyin-electron-integration.mjs` 检查真实 Electron、受控 HTTPS 夹具、IPC、截图和发布回归；`pnpm exec playwright test --config playwright.douyin.config.ts` 检查渲染层交互。测试夹具拦截平台域名，不能证明线上页面兼容性。

真实验收需要由用户提供测试账号、手动完成登录和必要验证，并给出可核对的其他作者作品链接。分别核对作品与作者、面板显示、收起、明确空态和访问受限。记录人工看到的状态、时间与本机观察记录的差异，再据实调整适配器。评论数据读取和商业存储的授权范围须在任何后续采集工作之前单独确认。

