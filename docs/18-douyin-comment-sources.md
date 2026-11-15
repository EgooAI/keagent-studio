# 给已核验作品配置评论来源

先在桌面端用目标账号完成作品核验。打开「AI 获客」的已核验作品列表，进入该作品的评论详情。页面按当前工作台用户、设备、抖音账号和作品选择来源。已登录 Electron Profile 的访问权限仅用于正常页面观察。评论正文的来源、用途、字段、保存期限和适用的第三方处理方需要由运营方事先核实。

## 从视频到人工私信

1. 在「AI 获客」点击「从视频获取评论」，选择本机已登录的抖音账号，填入作品链接并开始核验。系统会复用该账号下已有的同一视频目标。
2. 作品核验成功后进入「评论明细」，点击「同步评论」读取已配置的来源。也可以从「运行历史」或「已核验作品」重新打开评论明细。
3. 展开一条评论，点击分析按钮，核对意图和模型引用的原文。来源同时允许人工跟进时，可以编辑、复制相关评论的私信草稿。
4. 来源提供对应用户主页且允许跟进时，点击「打开主页 · 人工私信」。在当前账号的抖音网页上核对收件人，使用平台提供的私信入口并确认发送。工作台只记录评论同步，未获取私信送达回执。

## 在 Go 服务上绑定授权

1. 确认数据提供方有权提供这些字段和相应使用范围。分别核对保存、模型分析以及联系评论者的用途。保存授权凭据或平台审批记录，并给该记录分配一个不含个人资料或令牌的 `ref`。
2. 从该次已核验运行取得四个标识。使用工作台内部账号 ID；此值与抖音展示昵称、抖音号和开放平台的 `open_id` 各自独立。运维可在应用数据库用下列只读查询核对。

   ```sql
   SELECT owner_id, device_id, payload->>'accountId' AS account_id,
          payload->>'verifiedWorkId' AS work_id
   FROM keagent_collection_runs
   WHERE id = '<已核验的运行 ID>' AND observed_at IS NOT NULL;
   ```

3. 在 Go 服务账户可读、仅授权运维可写的私有目录创建授权清单。给服务进程配置环境变量 `KEAGENT_COMMENT_GRANTS_FILE`，值为该清单的**绝对路径**。例如，在启动服务的 PowerShell 中执行 `$env:KEAGENT_COMMENT_GRANTS_FILE = 'C:\KeAgentPrivate\grants.json'`。将授权文件、提供方导出及令牌留在仓库外。文件使用 UTF-8 无 BOM。
4. 每个四元组至多配置一条来源。每次同步及访问都会重新读取授权文件。变更时先写完整临时文件，再在同一目录原子替换，避免客户端看到半份配置。改变进程环境变量后重启 Go 服务。

### 导入经授权的导出文件

以下是**合成数据示例**。部署时替换为实际内部标识、授权引用、允许的字段、有效期和来源的实际观察时间。若无法确认字段，省略或填 `null`。保持明确观测到的数字 `0`。

`grants.json`

```json
[
  {
    "ownerId": "fixture-owner",
    "deviceId": "fixture-device",
    "accountId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "workId": "10013",
    "kind": "export",
    "ref": "fixture-proof-1",
    "label": "学习用合成样本",
    "fields": ["comment_id", "parent_comment_id", "comment_text", "commenter_name", "like_count", "reply_count"],
    "expiresAt": "2026-12-14T00:00:00Z",
    "retentionDays": 7,
    "exportFile": "work-10013.json"
  }
]
```

在同一目录创建 `work-10013.json`。使用单个文件名，正文和回复按提供方给出的关系绑定。

```json
{
  "sourceRef": "fixture-proof-1",
  "ownerId": "fixture-owner",
  "deviceId": "fixture-device",
  "accountId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "workId": "10013",
  "snapshotId": "fixture-20261114-1",
  "observedAt": "2026-11-14T08:30:00Z",
  "coverage": "partial",
  "items": [
    {"comment_id": "sample-p1", "comment_text": "合成示例正文", "commenter_name": "示例甲", "like_count": 0, "reply_count": 1},
    {"comment_id": "sample-r1", "parent_comment_id": "sample-p1", "comment_text": "合成示例回复"}
  ]
}
```

在评论详情手工同步并刷新。相同快照重复导入时复用同一 `snapshotId`。新观察使用新 ID 和新的 `observedAt`。样本、截页和缺失回复使用 `partial`，来源没有覆盖说明时使用 `unknown`；只有提供方确认该时点完整覆盖本次授权范围才可填写 `complete`。空数组配合 `partial` 或 `unknown` 只表示这份文件没有记录。单个导出最多 2 MiB、1,000 行。

支持的八个字段为 `comment_id`、`parent_comment_id`、`comment_text`、`commenter_name`、`commenter_profile`、`comment_time`、`like_count`、`reply_count`。有截断的正文额外标记 `"truncated": true`。导出中的时间使用带时区的 RFC 3339 格式。提供方明确给出的抖音公开主页可使用 `https://www.douyin.com/user/…` 标准地址。缺少稳定评论标识的观察只对当前快照有效；昵称和主页地址均不可作为稳定用户 ID。

### 对接已开通的小程序开放能力

抖音开放平台小程序文档将「视频评论数据」能力标为「暂不开放」，要求 `ma.item.comment` 和用户授权。仅当平台已向相应应用授予该能力，并确认该授权账号可读取目标作品时才配置此来源。用户能在抖音页面看到其他博主的作品，不能据此确认开放平台授权覆盖该作品。[评论列表](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/develop/server/basic-abilities/video-id-convert/video-review-data/comment-list) · [回复列表](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/develop/server/basic-abilities/video-id-convert/video-review-data/comment-reply-list)

沿用上述四个标识、`ref`、`label`、`fields`、`expiresAt` 和 `retentionDays`。移除 `exportFile`，改用以下来源属性。

```json
{
  "kind": "douyin_miniapp",
  "openId": "<官方授权返回的本应用用户 open_id>",
  "itemId": "<平台明确对应到该 workId 的加密 item_id>",
  "tokenEnv": "KEAGENT_DOUYIN_COMMENT_TOKEN_EXAMPLE"
}
```

由运营方通过开放平台正式授权流程获取用户 access token，注入服务端 `tokenEnv` 所指的环境变量，按平台流程续期。核对 `openId`、应用和授权作品的绑定。作品页 URL 中的十进制 ID 与开放接口要求的加密 `item_id` 分别配置；只有前者时仍缺少作品映射。不要把令牌、Cookie 或用户 Session 粘贴到桌面端或授权文件。

一次手动同步按时间顺序翻页，随后读取有授权字段和父评论标识的回复列表。单次最多 12 个请求、200 行或 40 秒。达到条数或请求上限会记录部分覆盖；网络错误、过期令牌和平台拒绝权限以错误结束。开放接口没有明确提供主页字段时保留空值。请求仅发往文档指定的开放平台评论及回复路径。

## 桌面端作品监控和私信

1. 在 KeAgent「设置 → 平台账号」选择抖音或小红书，登录并保存账号，返回工作台。
2. 在「AI 获客」选择对应账号、粘贴作品链接并确认授权。点击「只读取评论」查看原文，或点击「从评论中找客户」继续 AI 筛选。
3. 勾选「持续监控这条作品」可在桌面运行时每 15 分钟检查更新。打开「作品评论监控」可查看上次读数、错误、已保存的评论、立即读取或停止监控。平台分页、权限及排序可能限制覆盖范围。
4. 在单条评论上点击「写私信」，或在线索审核中编辑草稿后提交。发送前会复核账号、来源授权和收件人。视频发布和私信在发布中心的同一队列执行，结果待确认时到平台会话核对。
5. 评论采集、私信与队列均随 KeAgent Electron 主进程构建。启动 KeAgent 即可使用；云端继续提供原有的授权、评论存储及分析服务。
