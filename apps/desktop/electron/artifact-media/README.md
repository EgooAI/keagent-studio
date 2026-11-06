# 本机成片注册与解析

独立于制作器和发布器的 Electron Main 模块。`registerArtifactMedia` 返回真实 `LocalMediaRegistry`，由主入口注入发布运行时。共享成片类型、SDK 和夹具不变。

## 制作输出接入

制作端实现 `CompletedArtifactOutput` 端口，明确提供已完成任务的来源版本、内容和真实文件；只有 Main 能访问路径。当前全景制作的 `completedArtifactOutput` 已接入，拒绝示例、未完成任务和其他用户的任务。发布器不读取制作检查点。

结果页“登记成片到发布中心”调用白名单 `producer.register({jobId})`。注册器复制视频、封面和可选字幕，探测格式并计算 SHA-256，再通过 ArtifactExchange 注册资产和待验收成片。同来源版本使用稳定请求键；重复操作返回原成片，不重置验收；内容变化必须新建来源版本。

注册表按用户和设备隔离，原子写入不透明令牌与资产映射。解析时检查身份、会话代次、设备、绑定资产、大小和 SHA-256。真实视频探测要求系统有 FFprobe，或设置 `FFPROBE_PATH`。不提供虚假解析器或示例回退。

文件丢失时，`asset.restore({assetId})` 打开 Main 原生选择器，只接受与原资产大小及哈希一致的文件，并复制到受控目录。Renderer 不提供也不接收绝对路径。预览仍使用发布模块的受认证协议。

## 用户操作

真实制作完成 → 登记到发布中心 → 验证文件并预览 → 明确验收通过 → 接收成片 → 选择账号并立即发布。恢复文件不修改成片验收，编辑平台文案不修改来源内容。

未来制作器复用本模块和输出端口，不建立第二份 fileToken 映射。已登记文件保存在 Electron 用户目录；删除制作输出不会删除已登记的独立副本。

## 构建和验证

`pnpm build:publishing` 先构建本模块，再构建发布模块。开发、全量构建和打包均包含两个 CJS 运行时。

`registry.test.ts` 验证登记、重放、隔离、哈希、恢复、身份变更和示例拒绝。设置 `FFPROBE_PATH` 后运行 `node scripts/douyin-electron-integration.mjs` 可验证真实文件探测与发布内核的拦截链路。`services/cloud/artifact_media_integration_test.go` 在 Windows、`ADMIN_TEST_DATABASE_URL`、`ARTIFACT_MEDIA_ELECTRON_INTEGRATION=1` 和 FFprobe 可用时，连接临时 PostgreSQL schema 和真实 Go API；不访问真实抖音。
