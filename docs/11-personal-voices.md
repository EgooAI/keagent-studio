# 本人音色与系统音色

入口：桌面端「设置 → 声音与音色」。真实模式提供公共音色试听、本人录音上传、复刻状态查询、本人音色试听和移除。Mock 模式保留隔离的演示，不调用供应商。

全景工厂的配音服务可选择管理员上架的公共音色、当前用户已就绪的本人音色。本人音色由服务器解析为供应商音色，用户不填写供应商 ID。原有云端批次仍只执行文案阶段，此次没有扩展其下游生产能力。

## 服务端配置

```dotenv
DASHSCOPE_API_KEY=阿里云百炼华北2北京地域的API密钥
DASHSCOPE_WORKSPACE_ID=从控制台复制的业务空间ID
DASHSCOPE_VOICE_CLONE_ENABLED=true
```

公共配音、本人音色配音及声音复刻统一使用阿里云百炼华北 2（北京）的 `qwen-audio-3.1-tts-plus`。在后台「AI 服务 → 百炼语音」可配置共用的 API Key、业务空间 ID 和声音复刻开关，并在同一窗口运行配音样例或复刻训练。业务空间 ID 支持 `ws-` 和 `llm-` 前缀。创建音色免费，试听和正式合成计入语音合成用量。本应用的积分定价由后台独立管理。 [获取业务空间 ID](https://help.aliyun.com/zh/model-studio/obtain-the-app-id-and-workspace-id) · [百炼计费](https://help.aliyun.com/zh/model-studio/model-pricing)

管理员在「AI 服务 → 公共音色」填写百炼系统音色编号并上下架。已上架过的音色编号、模型和语言锁定，更换时需新建。服务初次部署时上架千问 3.1 Plus 的四个普通话系统音色：龙安灵心、许南川、龙安欢、龙安风悦。重启服务会保留已上架音色的编辑和上下架状态。 [百炼系统音色](https://help.aliyun.com/zh/model-studio/qwen-audio-tts-voice-list)

音色创建直传 Base64 录音，状态通过 `query_voice` 查询。正式配音和试听使用百炼 HTTP 流式合成，云端向桌面端返回 24 kHz PCM，试听封装为 WAV。 [声音复刻 API](https://help.aliyun.com/zh/model-studio/voice-clone-design-http-api) · [语音合成 API](https://help.aliyun.com/zh/model-studio/qwen-audio-tts-http-api)

## 使用与数据边界

- 上传 WAV、MP3 或 M4A，最多10 MB；界面检查时长5–30秒，推荐10–15秒清晰单人录音。服务器再次检查大小、格式标识和授权确认，最终录音质量由供应商校验。
- 桌面端明确告知录音会发送给阿里云百炼。认证接口在收到对应授权后转发。业务数据库记录归属、授权时间、状态、请求指纹与供应商检查点。
- `keagent_voice` 保存本人音色记录。查询、试听、移除与合成时均核对用户归属。
- 同一用户和请求键只提交一次，内容变化返回 409。提交结果不确定时，按创建前缀到百炼查询，避免重复上传。浏览器断开后仍尝试保存提交结果。
- 试听对就绪音色合成固定样句。移除时先删除百炼音色、释放配额，再归档本应用记录。

## 从旧语音服务迁移

已有火山本人音色需要用原始录音重新复刻，旧条目会提示迁移。旧公共音色自动下架，原内置 VV 或温怀清的默认音色选择对应到龙安灵心。使用其他旧音色的草稿需重新选择可用音色后制作。历史已渲染音频和成片可继续使用。部署时应同步更新云端、后台和桌面端，旧桌面端需更新后才能提交录音。

## 验证

```powershell
corepack pnpm lint
corepack pnpm test
corepack pnpm build
node scripts/voice-integration.mjs
```

Go 的 `voice_test.go` 覆盖文件验证、状态映射、归属、独立合成资源、超时、并发幂等及断开后的检查点。设置本机测试数据库环境变量 `ADMIN_TEST_DATABASE_URL` 后运行 `go test ./...`，数据库检查使用临时独立 schema 并在完成后清理。供应商请求由测试适配器替代，不产生付费调用。

`voice-integration.mjs` 验证登录、未开通提示、Electron 中的公共音色目录与本人照片限制。浏览器上传、状态和本人音色选择使用接口夹具。供应商权限和实际音质需要使用有效的百炼凭证和授权录音联调。
