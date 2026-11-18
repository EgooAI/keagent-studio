# 抖音短视频发布运行时

桌面端通过抖音创作者中心网页发布短视频，支持单条立即或定时发布，以及同账号批量立即发布。受控 Electron 页面、持久化 Profile 和登录检测源于 AutoUp-On 提交 `510132af0462a2bccd421ae264a7edab3a393982`。

## 边界和入口

- `index.ts` 组装白名单 IPC、本机文件、浏览器与直接执行器。Main 只注入当前认证上下文、云端请求和共享成片端口。
- `core.ts` 固定交接引用、重新验证验收及资产、提交边界、防重放和终态日志。
- `browser.ts` 将用户、设备和账号映射到隔离 Session；第三方页面没有应用 Preload、Node 能力或通用 IPC。浏览器和上传请求统一使用 Session 的系统代理配置。
- `files.ts` 通过注入的解析器取得原始文件，复制后重新校验大小与 SHA-256；替换封面单独保存在消费侧。Renderer 只收到不透明引用与受认证的 `keagent://douyin` URL。

浏览器界面由当前应用的 React 组件提供标签和工具栏，Main 对测量矩形进行约束。发布时使用该账号的后台网页，避免手动输入干扰自动操作。应用发布工作台显示进度和记录。

## 制作侧接入

共享 `artifact.ts`、ArtifactExchange SDK 和 JSON 夹具不变。默认桌面入口已通过中立的 `artifact-media` 模块注入真实 `LocalMediaAssetResolver`。当前全景制作只通过显式完成结果端口登记文件；发布器不导入制作执行器、不读取检查点、不猜文件路径。

真实成片在结果页登记为待验收成果，用户验证文件并预览后明确验收，再创建发布交接。注册表按用户、设备和资产绑定，保存独立副本，核对大小与 SHA-256；文件丢失可通过原生选择器恢复完全相同的原文件。详见 [本机成片注册与解析](../artifact-media/README.md)。独立调用者未注入解析器时仍明确返回 `RESOLVER_UNAVAILABLE`。

## 执行和恢复

用户明确接收成片后创建不可变交接。平台标题、正文和话题属于消费记录。发布前及最终提交前重新检查当前验收、资产及登录身份。

发布器通过网页文件选择器上传视频，输入标题和正文，将交接封面上传为抖音 3:4 竖封面，并核对公开、立即发布、关闭保存权限和不同步等设置。封面上传未获确认时停止提交。竖封面的网页操作参考 [auto-upload 的抖音上传器](https://github.com/s840207702/auto-upload/blob/054f01ecc8f441f120abba4333cdc73e8f025802/uploader/douyin_uploader/main.py#L338-L423)。

单条预约在用户确认时上传并提交给抖音。预约时间按北京时间显示，以整数 Unix 秒写入发布记录。提交前回读网页时间，定时提交请求的时间必须与预约时间相同。已排期作品可从创作者中心管理，核对公开状态或取消后可在 KeAgent 记录结果。日期控件操作参考 [auto-upload 的定时发布](https://github.com/s840207702/auto-upload/blob/054f01ecc8f441f120abba4333cdc73e8f025802/uploader/douyin_uploader/main.py#L97-L151)。

执行状态为 `running / submitting / accepted / failed / unknown / canceled`。本机写入 `submitting` 日志并获得云端确认后，只点击一次网页的发布按钮。发布器读取网页发出的提交回执，有效作品 ID 记为 `accepted`。明确的平台拒绝记为失败，超时或回执不明时转为待核对。平台审核与作品可见性由抖音决定。

本机终态先落盘，再向云端回报。终态回报失败每30秒或重新打开应用时补交，补交不调用发布内核。中断的 running 恢复为 failed/INTERRUPTED，submitting 恢复为 unknown。云端90秒未收到心跳同样将提交阶段转为 unknown。未知结果必须由用户去创作者中心核对，再记录作品链接或明确确认未发布；人工判断保留来源标记，不能被迟到的自动回报覆盖。

## 网页适配

`plugins/publish/opencli/douyin/publish.ts` 集中维护创作者中心控件和回执校验。网页改版导致控件不可用时，可从发布记录定位视频上传、文案、发布设置或提交阶段。原 OpenCLI 上传代码的许可保存在 `plugins/publish/OPENCLI_LICENSE`。

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

隐藏 Electron 使用真实测试文件、默认注册器和解析器，以及隔离 Session 的 HTTPS 页面夹具。用例覆盖登录、视频与封面上传、文案输入、发布设置、单次提交、作品 ID 和中断恢复。Go 集成测试使用真实共享 API 和临时数据库 schema，结束后清理测试记录。真实抖音网页的兼容性需单独验证。

目录打包先将桌面构建产物暂存到 `output/desktop-app`，独立清单不声明运行时外部依赖；构建钩子防止打包工具把整个pnpm工作区的后台依赖带入客户端。上面的electronDist命令复用当前平台已安装的Electron；跨平台构建需匹配的分发文件。目录包为未签名验证产物。

真实平台接口兼容性、账号权限和发布效果仍须使用明确授权的测试账号单独验证。
