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

## 用途、撤回和保存期限

可选 `analyzeWithAI` 和 `manualContact` 默认为 `false`。只有数据来源的授权也覆盖将评论正文提交到相应 AI 服务分析时，才将 `analyzeWithAI` 设置为 `true`，允许字段包含 `comment_text`，并将 `aiEndpoint` 绑定到经许可的 HTTPS 模型服务基础地址（可含 `/v1`），与工作台模型配置相符。模型输入限于评论正文，昵称、主页和评论 ID 都不作为独立字段发送。正文自身也可能包含个人资料，应一并核对传递范围。

只有跟进目的也获准时才设置 `manualContact: true`。这个开关记录数据提供方允许的用途。能否联系、如何联系仍受平台的账号权限、目标用户的接收设置及适用规则约束。

缩小字段或用途、到期或撤回时，将对应条目更新为现行授权，可使用 `"revoked": true` 立即标记撤回。已过期、撤回或配置移除的来源不会再提供已保存的评论。服务运行时定期清理数据，保存有效期上限取来源观察时间加 `retentionDays` 与 `expiresAt` 中较早者。授权管理方另行处理原始导出、备份及模型服务端的留存和撤回。平台明确拒绝权限后，运维应重新核实实际授权再更新授权记录。
