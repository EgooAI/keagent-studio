# AI来客 桌面更新发布

Windows x64 和 Apple 芯片 Mac 使用独立的 HTTPS 静态目录。每次应用发布前递增根 package.json 的 version。已经安装旧版的用户需手动安装一次带更新器的版本。

1. 使用 Desktop installers 工作流，填写用户可以访问的 HTTPS 服务源。Mac 构建需要 MAC_CSC_LINK（含私钥的 Developer ID Application 证书）、MAC_CSC_KEY_PASSWORD、APPLE_ID、APPLE_APP_SPECIFIC_PASSWORD、APPLE_TEAM_ID。Windows 签名使用 WIN_CSC_LINK 和 WIN_CSC_KEY_PASSWORD；正式发布前确认安装包的 Authenticode 发布者。
2. 下载工作流产物。将 Windows EXE 和 blockmap 放到 /opt/keagent/desktop-updates/win32-x64/。将 Apple 芯片的 DMG、ZIP 及 blockmap 放到 /opt/keagent/desktop-updates/darwin-arm64/。两端都先上传完整的版本化文件，保留旧版 blockmap，再原子替换对应目录的 latest.yml 或 latest-mac.yml。
3. 部署仓库的 Caddyfile 更新路由。若使用 CDN，保留 HTTP Range 和原始文件字节，更新清单重新验证缓存。Mac 初次缺少旧 ZIP 时会下载整包，后续版本可使用缓存做差分。
4. 用已安装的前一版在「设置 → 软件更新与关于」检查、下载并重启，确认新版版本号。发布或采集进行中可继续下载，任务完成后用户可手动重启。Mac 验收同时检查首次安装、Gatekeeper 和内置 Chromium；Windows 验收检查签名与升级后的发布者。

## 内容更新

在管理后台发布模板和制作参数。客户端按目录版本刷新，离线保留最近一次获取的目录，已创建的任务继续使用模板快照。

将 deploy/admin/desktop-updates/config-v1.json 放入 /opt/keagent/desktop-updates/，配置变更时递增 revision 并原子替换文件。catalogRefreshSeconds 可设为 30 到 3600 秒。renderDefaults 支持 rate、speed、maxSweep，沿用制作参数校验，模板和用户填写的值优先。发布更高的 revision 可以恢复旧设置。客户端在读取制作能力时刷新，配置无效或请求失败时继续使用本地上次成功保存的版本。
