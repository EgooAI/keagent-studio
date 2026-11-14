# 17 - 贝壳 CLI 接入

整理日期：2026-11-14。本文记录云端 Go 服务接入贝壳 AI 平台 CLI 的方式、可用接口，以及**服务端真实工具面**（哪些命令能用、哪些不能用）。

## 一、架构

云端**不直接请求**贝壳 MCP 服务端，而是 shell 出官方 `beike` CLI（v0.2.28）子进程，抓它的 stdout 再解析：

```
Go 服务 services/cloud
  └─ runBeikeCLIArgs()  [beike_cli.go]
       └─ exec.CommandContext(BEIKE_CLI_PATH, args...)
            ├─ 注入环境变量：BEIKE_MCP_API_KEY + WORKBUDDY_SESSION_ID
            ├─ beike.exe 自己发 HTTPS → https://building.ke.com/mcp（JSON-RPC/SSE）
            └─ 打印 {"data":"<文本>","ok":true} 到 stdout
       └─ 解析 stdout → 结构化结果
```

关键点：

- Go 不实现 MCP 协议；MCP 握手、工具调用、客户端身份全在 `beike.exe` 内部。
- 贝壳服务端按 User-Agent 里的宿主标识放行，**只有 workbuddy 身份能通过**；CLI 检测到 `WORKBUDDY_SESSION_ID` 环境变量即以上报 workbuddy。因此 Go 侧必须注入该变量（见 `beikeCLISessionID`），否则服务端返回 `invalid cli request`。
- 复用缓存（`beike_cache.go`）与并发闸门（`beikeCLIConcurrency`），命中缓存时完全跳过子进程 spawn。

## 二、HTTP 接口

所有接口在网关鉴权（HMAC `X-Keagent-Signature`）之后，Key 只留服务端。

| 接口 | 用途 | 说明 |
| --- | --- | --- |
| `POST /v1/beike-cli/search` | 按需求文本找二手房 | `{city, query}`，返回结构化房源 + 严格预算过滤 |
| `POST /v1/beike-cli/detail` | 按房源号批量查详情 | `{city, ids:[...]}`，一次最多 20 个，一次 CLI 调用 |
| `POST /v1/beike-cli/call` | 通用透传任意命令 | `{namespace, command, args}`，见下 |
| `POST /v1/beike-cli/commands` | 返回命令白名单 | 供前端发现能力 |
| `POST /v1/beike-cli/status` | 配置状态 | `available/configured/reason` |

### 通用透传 `call`

```json
POST /v1/beike-cli/call
{
  "namespace": "buy",
  "command": "resblock",
  "args": { "city": "北京", "query": "望京 改善小区" }
}
```

`args` 的值可以是字符串或字符串数组（数组用于重复参数，如 `"id": ["A","B"]`）。参数名与值都经白名单校验，防注入。返回：

```json
{ "namespace": "buy", "command": "resblock", "data": "<原始结果文本>", "ok": true }
```

命令不存在或服务端无对应工具时，返回明确的 `贝壳命令失败: Unknown tool: 'xxx'`。

### search / detail 结构化字段

- `search` 返回 `houses`（符合预算）+ `overBudget`（超预算，单独列）+ `conditions`（实际命中的检索条件，暴露底层放宽）。预算从查询文本解析「N万以内/以下」，严格过滤；`500万以内` 底层会放宽成 `总价 < 550万`，超预算的不会混进 `houses`。
- `detail` 返回比 search 更全的字段：挂牌时间、楼龄、产权年限、交易权属、供暖、燃气、用水用电，以及小区信息（物业费/容积率/绿化率/租售比/总户数）。

## 三、配置（服务端环境变量）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `BEIKE_CLI_PATH` | - | 官方 CLI v0.2.28 可执行文件的绝对路径 |
| `BEIKE_MCP_API_KEY` | - | 贝壳 AI 平台 API Key（服务端专用） |
| `BEIKE_CLI_SESSION_ID` | `keagent-studio-cloud` | 注入 `WORKBUDDY_SESSION_ID` 的值，决定上报身份 |
| `BEIKE_CLI_CONCURRENCY` | 2（1-64） | 并发 CLI 子进程上限，放宽前先小步验证贝壳容忍度 |
| `BEIKE_CLI_CACHE_TTL` | 300 秒（0=关） | 结果缓存 TTL |
| `BEIKE_CLI_CACHE_MAX` | 1024 | 缓存条目上限 |

另有 `BEIKE_ACCESS_TOKEN` 是**另一条独立直连通道**（开放平台 `gw-open.ke.com` 图片验真/房屋档案，按地址查），见 `production_sources.go`，与本文的 MCP CLI 通道不混用。

## 四、命令可用性清单（真实服务端工具面）

CLI 帮助里列了约 40 个子命令，但**贝壳服务端（workbuddy 身份）实际只挂了 19 个 MCP 工具**。下面按真实可用性分类（2026-11-14 实测）。

### 4.1 可用（✅）

| 命名空间 | 子命令 | 服务端工具 | 用途 |
| --- | --- | --- | --- |
| buy | search | house_search / newhouse_search | 二手房/新房搜索 |
| buy | detail | entity_detail | 房源/小区详情 |
| buy | material | entity_material | 房源图片/户型图/VR |
| buy | resblock | resblock_search | 小区搜索 |
| buy | plate | plate_search | 板块/商圈 |
| buy | rank | house_rank_search / resblock_rank_search | 房源榜/小区榜 |
| buy | store | store_search | 门店 |
| buy | agent | agent_search | 经纪人 |
| buy | resolve | entity_resolution | 实体名消歧 |
| buy | contact | wecom_add_contact_qrcode | 经纪人加微二维码 |
| rent | search | rent_house_search | 租房搜索 |
| rent | detail | entity_detail | 租房详情 |
| rent | material | entity_material | 租房图片 |
| rent | resblock | resblock_search | 小区搜索 |
| rent | plate | plate_search | 板块 |
| rent | store | store_search | 门店 |
| rent | agent | rent_agent_search | 租赁经纪人 |
| rent | agent-detail | entity_detail | 租赁经纪人详情 |
| rent | contact | wecom_add_contact_qrcode | 加微二维码 |
| sell | agent | agent_search | 卖房经纪人 |
| - | analyze | report_user_intent | 需求分析（`beike analyze`） |

### 4.2 工具存在但临时不可用（⚠️，测试时返回 `service temporarily unavailable`）

| 命名空间 | 子命令 | 服务端工具 | 用途 |
| --- | --- | --- | --- |
| policy | search | policy_search | 购房政策/税费/贷款 |
| decor | stores | decor_store_search | 装修门店 |
| decor | price | decor_price_query | 装修套餐报价 |
| decor | agent | agent_search | 装修顾问 |
| decor | contact | wecom_add_contact_qrcode | 加微二维码 |

注：`decorate_search`（装修案例）工具存在，但 CLI 无对应子命令，暂不可用。

### 4.3 服务端无此工具（❌，返回 `Unknown tool`，永远无法用）

| 命名空间 | 子命令 | 说明 |
| --- | --- | --- |
| buy | sold | 成交记录 |
| buy | market | 二手房市场行情 |
| buy | school | 学校 |
| buy | district | 学区范围 |
| buy | land | 土地/土拍 |
| buy | unready | 小区未上架房源 |
| rent | market | 租赁行情 |
| rent | appoint | 预约看房 |
| sell | list | 名下挂牌房源 |
| sell | dynamic | 房源动态 |
| map | geo / driving / transit | 地图（全部） |

这些命令在 CLI 帮助里存在，但对应的 MCP 工具不在服务端的 19 个工具内，调用必然失败。**市场行情/成交记录当前拿不到**——这是贝壳服务端能力边界，不是接入问题。

## 五、已知坑

1. **预算放宽**：`N万以内` 底层放宽约 +10%（`400万以内` → `<440万`，`500万` → `<550万`），必须用真实总价二次过滤。
2. **search 只回 Top10**：`totalRecalled` 是真实召回量，但 CLI 只返回推荐 Top10，分页参数未暴露。
3. **缓存粒度**：缓存在原始输出层，key 含完整参数；batch detail 换 ID 子集会 miss。
4. **多段 JSON**：`buy search` 默认同时查二手房+新房会连打两条 JSON；加 `--house-type second` 才单条。类型化 search 已固定 `--house-type second`。

## 六、代码位置

| 文件 | 职责 |
| --- | --- |
| `services/cloud/beike_cli.go` | CLI 执行核心、参数构建、输出校验、并发闸门 |
| `services/cloud/beike_search.go` | 二手房 search 解析、预算过滤 |
| `services/cloud/beike_detail.go` | 房源 detail 解析（批量） |
| `services/cloud/beike_command.go` | 通用命令白名单、`call` 透传 |
| `services/cloud/beike_cache.go` | 结果 TTL 缓存 |
| `services/cloud/beike_cli_entrypoints.go` | HTTP 路由 |

## 七、推荐开放范围（房源视频生产场景）

本项目核心链路是「获取房源数据 + VR/全景图 → 做视频」。据此，**推荐只开放 buy 命名空间里的房源数据相关命令**：

### 开放（核心 4 个）

| 命令 | 用途 | 对应视频环节 |
| --- | --- | --- |
| buy search | 按需求找二手房 | 选题 / 导入房源 |
| buy detail | 房源详情（价格/面积/户型/朝向/楼层/房龄/挂牌时间/标签/学区） | 文案事实 |
| buy resblock | 小区数据（物业费/容积率/绿化率/租售比/建成年代/楼栋户数） | 文案补充 |
| buy material | 户型图（⚠️ 仅户型图，非 VR/全景） | 视觉素材之一 |

### 开放（辅助 3 个，可选）

| 命令 | 用途 |
| --- | --- |
| buy resolve | 实体消歧（用户粘贴小区名/商圈名/房源标题 → 标准实体 ID） |
| buy plate | 板块/商圈（区位文案） |
| buy rank | 热门房源/小区榜（选题） |

### 不开放

- **contact（加微）**：属「AI 获客」链路，非视频生产；且需要真实 `agent-ucid`。
- **agent、store**：视频生产用不上。
- **sold / market / school / district / land / unready**：服务端无此工具，开不了。
- **rent / sell / decor / policy / map**：与「房源视频」无关（除非后续扩展租房视频）。

### 关于 VR/全景图（关键）

视频工厂的视觉素材有三个来源，**各有分工**：

| 素材 | 来源 | 获取方式 | 状态 |
| --- | --- | --- | --- |
| 房源数据（价格/面积/户型/朝向…） | MCP CLI（`buy search/detail`） | 按房源 ID / 需求 | ✅ 已接入 |
| 户型图 | MCP CLI（`buy material`） | 按房源 ID | ✅ 已接入 |
| 室内照片 + 户型图 + 小区图 + 外立面图 | 开放平台图片验真（`BEIKE_ACCESS_TOKEN`，`gw-open.ke.com`） | 按**地址** | ✅ 已接入（`production_sources.go`） |
| VR / 等距柱状全景图 | 如视 Realsee（`open.realsee.com`） | 打开 VR 页面 + `scripts/realsee-panorama.user.js` | ⚠️ 仅人工半自动 |

MCP CLI 的 search/detail/material 回包里**没有 VR 链接、没有 Realsee work ID、没有全景图**，只有 `media_type:["vr"]` 这个「该房源有 VR」的标记。`buy material` 实测只返回户型图。

**决定性验证**：`entity_material` 工具的 schema 确实列了 `fields:["VR"]`，但直接调 MCP `entity_material` 传 `fields:["VR"]` 返回空 `{}`，`fields:["房源图片"]` 也只返回户型图——说明贝壳服务端对二手房源的 material **实际不返回 VR 内容**，VR 字段是空的。`media_type:["vr"]` 只是「VR 存在（在如视 Realsee）」的标记，不是可取的 VR 数据。

「房源 ID → Realsee work ID / VR 页面链接」这个跳转信息在贝壳 Web/App 的「VR 看房」按钮里（`open.realsee.com/ke/<workId>/<token>`），是贝壳前端内部数据，**不在 MCP CLI 或开放平台图片验真里**。

如视 Realsee 开发者 API（`developer.realsee.ai`）面向 VR 内容所有者（用如视硬件扫描的人），有 AK/SK 认证和「VR 列表」接口，但**不是按贝壳房源 ID 查公开 VR 的接口**。

因此 VR/全景图的自动化缺一环。实测结论（2026-11-14）：

- **贝壳 Web 房源详情页（VR 链接所在）被 CAPTCHA + 登录墙保护**：`bj.ke.com` 列表页部分可见（只有「VR 看房」徽标，无真实链接），房源详情页直接 302 重定向到 `hip.ke.com/captcha` 验证码页。破解验证码属明确违规，路线 A 走不通。
- **Realsee 页面公开可访问**：`open.realsee.com/ke/<workId>/<token>` 无登录/验证码，页面内嵌六面图数据，现有脚本可下载。

所以 VR 内容公开、但「房源 ID → work ID」链接被贝壳验证码墙挡住。剩下两条：① 与如视/贝壳建立开发者合作关系拿 VR work 授权（商务路线，正路）；② 维持 Realsee 脚本人工半自动。
