# 抖音短视频发布运行时

从 AutoUp-On 提交 `510132af0462a2bccd421ae264a7edab3a393982` 迁移抖音视频内核、受控 Electron 页面、持久化 Profile 和登录检测。仅支持单视频、单账号立即发布，不包含图文、排期、Workflow 或云端调度器。

## 边界和入口

- `index.ts` 组装白名单 IPC、本机文件、浏览器与直接执行器。Main 只注入当前认证上下文、云端请求和共享成片端口。
- `core.ts` 固定交接引用、重新验证验收及资产、提交边界、防重放和终态日志。
- `browser.ts` 将用户、设备和账号映射到隔离 Session；第三方页面没有应用 Preload、Node 能力或通用 IPC。浏览器和上传请求统一使用 Session 的系统代理配置。
- `files.ts` 通过注入的解析器取得原始文件，复制后重新校验大小与 SHA-256；替换封面单独保存在消费侧。Renderer 只收到不透明引用与受认证的 `keagent://douyin` URL。

浏览器界面由当前应用的 React 组件提供标签和工具栏，Main 对测量矩形进行约束。原生视图在应用弹窗、抽屉和隐藏窗口期间隐藏；账号发布执行时禁用导航和删除操作。

## 制作侧接入

共享 `artifact.ts`、ArtifactExchange SDK 和 JSON 夹具不变。默认桌面入口已通过中立的 `artifact-media` 模块注入真实 `LocalMediaAssetResolver`。当前全景制作只通过显式完成结果端口登记文件；发布器不导入制作执行器、不读取检查点、不猜文件路径。

真实成片在结果页登记为待验收成果，用户验证文件并预览后明确验收，再创建发布交接。注册表按用户、设备和资产绑定，保存独立副本，核对大小与 SHA-256；文件丢失可通过原生选择器恢复完全相同的原文件。详见 [本机成片注册与解析](../artifact-media/README.md)。独立调用者未注入解析器时仍明确返回 `RESOLVER_UNAVAILABLE`。

## 执行和恢复

用户明确接收成片后创建不可变交接。平台标题、正文、话题及替换封面均属于消费记录。发布前及最终提交前重新检查当前验收、资产及登录身份。

执行状态为 `running / submitting / accepted / failed / unknown / canceled`。本机写入 submitting 日志并获得云端确认后，最终 create_v2 请求只执行一次；页面跳转、超时、响应丢失不触发自动重发。明确的平台拒绝才转为可重新操作的失败。拿到作品 ID 的 accepted 表示平台已接收，不代表审核通过。

本机终态先落盘，再向云端回报。终态回报失败每30秒或重新打开应用时补交，补交不调用发布内核。中断的 running 恢复为 failed/INTERRUPTED，submitting 恢复为 unknown。云端90秒未收到心跳同样将提交阶段转为 unknown。未知结果必须由用户去创作者中心核对，再记录作品链接或明确确认未发布；人工判断保留来源标记，不能被迟到的自动回报覆盖。

## 来源与适配差异

抖音视频算法源于 `jackwener/opencli` 提交 `0e73c3c2c2b45c91e050e1618b20e2aba22f1a23`，Apache-2.0 原文保存在 `plugins/publish/OPENCLI_LICENSE`。AutoUp-On 对立即发布时间 `0` 的适配参考 `dreammis/social-auto-upload` 提交 `008e4ff66abdf48eb1f4b999272ef979711af436` 的协议语义，未引入其 Python Runtime 或图文 stealth 脚本。

本次在来源实现上明确修改：导入和构建位置、系统 Session 网络注入、结构化进度、安全日志、最终单次提交、上传地址范围检查、续传绑定账号/资产哈希/原目标、同编号分片有限重试及明确拒绝分类。保留来源上传凭证、VOD/TOS、ImageX、话题偏移、安全预检与 create_v2 顺序。预检服务持续不可用时保留来源的提交后平台审核行为，并记录 `safety_precheck_unavailable`。

## 检查

在仓库根目录执行：

```powershell
corepack pnpm build:publishing
corepack pnpm lint
corepack pnpm test
corepack pnpm exec playwright test --config playwright.douyin.config.ts
node scripts/douyin-electron-integration.mjs
corepack pnpm package:desktop --config.electronDist=node_modules/electron/dist
node scripts/douyin-package-smoke.mjs
```

隐藏 Electron 使用显式真实测试文件、默认注册器和解析器，以及隔离 Session 的 HTTPS 协议拦截，实际运行文件探测、登记、浏览器登录与上传内核，不访问真实抖音。默认使用内存业务适配器；Go 集成测试可切换到真实共享 API 和临时数据库 schema，结束后清理测试记录。用户 UI 测试使用接口夹具，不代表真实平台成功。

目录打包先将桌面构建产物暂存到 `output/desktop-app`，独立清单不声明运行时外部依赖；构建钩子防止打包工具把整个pnpm工作区的后台依赖带入客户端。上面的electronDist命令复用当前平台已安装的Electron；跨平台构建需匹配的分发文件。目录包为未签名验证产物。

真实平台接口兼容性、账号权限和发布效果仍须使用明确授权的测试账号单独验证。
