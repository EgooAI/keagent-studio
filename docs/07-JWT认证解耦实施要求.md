# Better Auth 与 Go 认证解耦实施要求

2026-11-03。补齐原需求中“应用层必须”之后的约束，作为本次改造及验收基线。

## 应用边界与兼容迁移

- 保留 SDK、用户 ID、Session、登录、现有管理员功能及既有认证配置；不启用原本未配置的注册、OAuth 或密码重置功能。
- 认证请求仍到 Next.js `http://127.0.0.1:18080/api/auth/*`；业务请求直接到 Go `http://127.0.0.1:18081/v1/*`。沿用实际 `/v1` 路由，不为了示例中的 `/api/v1` 重命名接口。
- 实际前端端口为桌面开发网页 5173、管理后台 5174。开发期 Vite 只代理认证请求，业务请求直接跨端口访问 Go。
- 保留旧 Next.js `/v1/*` 签名代理供旧客户端迁移，通过 `ALLOW_LEGACY_GATEWAY=false` 在两端禁用。JWT 失败不得自动回退旧认证方式；关闭旧代理后 Go 不再需要内部共享密钥。
- 保持 pnpm 启动命令、PostgreSQL 部署和现有业务数据。不引入反向代理、Docker、Redis 或新的独立认证系统。

## JWT 与公钥

- 使用现有 SDK 已导出的 JWT 插件，`GET /api/auth/token` 用有效 Cookie / 桌面签名 Session 换取 Access Token，`GET /api/auth/jwks` 仅发布公钥。
- 使用 EdDSA / Ed25519 非对称签名，Access Token 有效期 5 分钟；`sub` 严格沿用用户 ID，携带 Session ID (`sid`)、`iss`、`aud`、`iat`、`exp`，不包含 Session 凭据或供应商密钥。
- 签名私钥由 SDK 在 PostgreSQL 管理并默认加密，使用现有 `pnpm setup:auth` 增量迁移 JWKS 表。自动轮换 30 天，旧公钥至少保留 10 分钟。
- Go 使用成熟 JWT 库，固定算法，校验签名、kid、issuer、audience、有效期、签发时间、可选 nbf、非空 sub / sid 和最长有效期。拒绝 none、HMAC 算法混淆、伪造头和缺失声明。
- Go 仅访问配置的 JWKS 地址，不信任 Token 内的 jku / x5u。缓存公钥 5 分钟；未知 kid 触发受限刷新，合并并发刷新并限制响应体、超时与重定向。过期缓存刷新失败或未知公钥时拒绝访问，不无限使用过期公钥。

## 实时安全状态与业务授权

- 本仓库没有 Redis 使用配置，第一阶段不安装 Redis。JWT 验签无状态，封禁、退出、撤销会话和当前角色检查有状态，二者明确区分。
- Go 验签后直接通过 PostgreSQL 联查现有 Session / user，校验用户与会话对应、会话未过期、用户未被封禁，并读取当前角色。查询失败必须拒绝访问。
- 第一阶段保留每请求一次身份状态查询，优先保证撤销和权限变更在下一请求生效；不声称消除了数据库查询。未来优化缓存时需另行确定允许的撤销延迟及跨实例失效机制。
- Go 自己校验管理员权限、资源归属和设备的用户 / 会话 / 撤销状态。JWT 中的角色和客户端身份头均不能覆盖数据库身份；普通用户不可跨账号读写。
- 401 表示认证失败；403 表示权限或设备状态拒绝；认证依赖不可用返回服务错误，不绕过校验。日志和错误不得输出 Token、Cookie、密码或私钥。

## 客户端与跨域

- 浏览器 Access Token 仅保存在内存，刷新页面后用 HttpOnly Session Cookie 重新换取；业务请求只携带 Bearer JWT，不携带认证 Cookie。
- Electron 保留 Main 的系统加密 Session 持久化与受限 IPC；JWT 只在 Main 内存，不暴露给 Renderer，不写 localStorage。
- 两端复用正在进行的 Token 获取，过期前续取；401 最多刷新并重试一次，403 不重试。仅在认证尚未通过时重试业务请求，网络错误或业务错误不自动重放写操作。
- 登录、退出、失效与换账号必须清除 JWT 缓存，防止旧的异步换取结果恢复已经清除的登录态。
- Go CORS 精确匹配允许的浏览器 Origin，支持 Authorization / Content-Type / X-Keagent-Device 预检，不使用通配来源或 Cookie 凭据。认证端保留 Better Auth 的来源与 CSRF 检查。
- 认证 URL、业务 URL、issuer、audience、JWKS URL 由环境配置；本地允许回环 HTTP，未来外部地址使用 HTTPS，不包含本次域名或代理部署工作。

## 验收与交付

- 验证正常签发及直连、非法签名 / 算法 / 声明、Token 过期、公钥轮换与缓存故障、CORS、非管理员与跨用户访问、设备撤销、封禁、退出、Session 撤销及角色降级。
- 验证并发换取、Token 续取、退出时竞态、401 有界重试、浏览器 Cookie 和 Electron IPC / 加密凭据边界。
- 验证旧签名入口仍可用且可关闭；拥有缓存公钥和未过期 JWT 时，Next.js 暂不可用不阻断 Go 请求（PostgreSQL 仍必须可用）。
- 运行 Go 测试与 vet、TypeScript 检查、相关前端测试及构建；本机依赖可用时运行跨服务及浏览器 / Electron 联调。明确报告未能执行的检查。
- 同步 `.env.example` 与联调文档，交代增量迁移、直连配置、兼容开关、回退方法及实时状态查询成本；不改写 vendor 包或 node_modules。

参考：SDK 安装包中的 Better Auth 1.7.6 源码、[Better Auth JWT 文档](https://www.better-auth.com/docs/plugins/jwt)、[golang-jwt 校验选项](https://golang-jwt.github.io/jwt/usage/parse/)。以仓库固定版本实际接口为准。
