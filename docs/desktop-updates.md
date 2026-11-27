# AI来客 桌面更新发布

Windows x64 和 Apple 芯片 Mac 使用独立的 HTTPS 静态目录。每次应用发布前递增根 package.json 的 version。已经安装旧版的用户需手动安装一次带更新器的版本。

1. 使用 Desktop installers 工作流，填写用户可以访问的 HTTPS 服务源。Mac 构建需要 MAC_CSC_LINK（含私钥的 Developer ID Application 证书）、MAC_CSC_KEY_PASSWORD、APPLE_ID、APPLE_APP_SPECIFIC_PASSWORD、APPLE_TEAM_ID。Windows 签名使用 WIN_CSC_LINK 和 WIN_CSC_KEY_PASSWORD；正式发布前确认安装包的 Authenticode 发布者。
2. 下载工作流产物。将 Windows EXE 和 blockmap 放到 /opt/keagent/desktop-updates/win32-x64/。将 Apple 芯片的 DMG、ZIP 及 blockmap 放到 /opt/keagent/desktop-updates/darwin-arm64/。两端都先上传完整的版本化文件，保留旧版 blockmap，再原子替换对应目录的 latest.yml 或 latest-mac.yml。
3. 部署仓库的 Caddyfile 更新路由。若使用 CDN，保留 HTTP Range 和原始文件字节，更新清单重新验证缓存。Mac 初次缺少旧 ZIP 时会下载整包，后续版本可使用缓存做差分。
4. 用已安装的前一版在「设置 → 软件更新与关于」检查、下载并重启，确认新版版本号。发布或采集进行中可继续下载，任务完成后用户可手动重启。Mac 验收同时检查首次安装、Gatekeeper 和内置 Chromium；Windows 验收检查签名与升级后的发布者。

## Apple 芯片 Mac 异步公证

推送到 `codex/desktop-packaging`，或在该分支手动运行 **Desktop installers**，会按当前提交的版本和 HTTPS 服务源构建。Windows 安装包独立生成。Mac 的原始运行保存 `mac-signed` 和 `mac-notary-receipt` 30 天，提交 Apple 后释放 Mac 构建机。GitHub 在第一小时每 10 分钟复查一次，之后每小时复查，等待由 Linux 任务承担。

Apple 返回 `Accepted` 后，工作流检出原始提交、核对签名包的 SHA-256、装订票据，生成并检查 DMG 和更新 ZIP。已有前一版本时，工作流从该版本分别执行整包和差分升级，验证重启版本。首次版本执行安装包检查，并为下次升级建立基线。最终产物名为 `AI-Laike-mac-arm64`，位于完成验收的运行中。后续查询的运行标题包含原始运行 ID。

如任务中断，回执保存前可在原始运行中重试失败的任务。回执保存后，在正式打包分支手动运行 **Desktop installers**，将原始运行 ID 填入 `notary_run`。需要指定升版本的起点时，`baseline_run` 填入正式打包分支上保有前一版 `AI-Laike-mac-arm64` 的运行 ID。苹果拒绝提交时可在状态查询步骤查看诊断。工作流仅生成 GitHub Actions 产物，用户收到新版的时间由上面的更新目录发布步骤决定。

## 内容更新

在管理后台发布模板和制作参数。客户端按目录版本刷新，离线保留最近一次获取的目录，已创建的任务继续使用模板快照。

将 deploy/admin/desktop-updates/config-v1.json 放入 /opt/keagent/desktop-updates/，配置变更时递增 revision 并原子替换文件。catalogRefreshSeconds 可设为 30 到 3600 秒。renderDefaults 支持 rate、speed、maxSweep，沿用制作参数校验，模板和用户填写的值优先。发布更高的 revision 可以恢复旧设置。客户端在读取制作能力时刷新，配置无效或请求失败时继续使用本地上次成功保存的版本。
