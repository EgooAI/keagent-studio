/** Publishing owns these records; the immutable artifact contract stays unchanged. */
export type DouyinPublishState =
  "running" | "submitting" | "accepted" | "failed" | "unknown" | "canceled";
export type PublishPlatform = "channels" | "douyin";
export type SocialPlatform = PublishPlatform | "xhs";
export const publishPlatformLabels: Record<PublishPlatform, string> = {
  channels: "微信视频号",
  douyin: "抖音",
};
export interface DouyinAccount {
  platform?: SocialPlatform;
  id: string;
  deviceId: string;
  name: string;
  platformUserId?: string;
  loginStatus: string;
  lastCheckedAt: string;
  unboundAt?: string;
}
export interface DouyinPublishInput {
  platform?: PublishPlatform;
  requestKey: string;
  handoffId: string;
  accountId: string;
  title: string;
  shortTitle?: string;
  description: string;
  hashtags: string[];
  coverRef?: string;
  batch?: boolean;
  /** Unix seconds at minute precision, omitted for immediate publishing. */
  scheduledAt?: number;
}
export interface DouyinPublishLog {
  step: string;
  status: "started" | "completed" | "failed";
  timestamp: string;
  durationMs?: number;
  errorCode?: string;
}
export type DouyinMessageStep =
  | "check_account"
  | "open_conversation"
  | "fill_message"
  | "trigger_send"
  | "verify_conversation"
  | "recheck_conversation";
export interface DouyinMessageStepLog extends DouyinPublishLog {
  step: DouyinMessageStep;
  errorMessage?: string;
}
export interface DouyinPublishRecord extends DouyinPublishInput {
  id: string;
  ownerId: string;
  deviceId: string;
  artifactId: string;
  state: DouyinPublishState;
  progress: number;
  createdAt: string;
  updatedAt: string;
  externalId?: string;
  url?: string;
  resultSource?: "platform" | "manual";
  errorCode?: string;
  logs: DouyinPublishLog[];
}
export type DouyinPublishStartResult =
  DouyinPublishRecord | { id: string; state: "queued" };
export interface DouyinBrowserTab {
  platform?: SocialPlatform;
  accountId: string;
  title: string;
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  saved: boolean;
}
export interface DouyinDesktopState {
  deviceId: string;
  resolverAvailable: boolean;
  tabs: DouyinBrowserTab[];
  activeAccountId?: string;
  channelsLoginAccountIds?: string[];
  channelsLoginError?: { accountId: string; message: string };
  channelsVerificationAccountId?: string;
  activeRecord?: DouyinPublishRecord;
  queue?: DouyinQueue;
}

export type DouyinWorkspaceStatus =
  "unpublished" | "running" | "accepted" | "scheduled" | "unknown" | "failed";
export interface DouyinWorkspaceRow {
  id: string;
  title: string;
  propertyTitle?: string | null;
  sourceRevision: number;
  review: import("./artifact").VideoArtifact["review"];
  createdAt: string;
  status: DouyinWorkspaceStatus;
  recordState?: DouyinPublishState | null;
  recordId?: string | null;
  resultSource?: DouyinPublishRecord["resultSource"] | null;
  scheduledAt?: number | null;
  progress?: number | null;
  deviceReady: boolean;
}
export interface DouyinWorkspace {
  items: DouyinWorkspaceRow[];
  counts: Partial<Record<DouyinWorkspaceStatus, number>>;
  total: number;
}
export interface DouyinQueueEntry {
  artifactId: string;
  expectedReviewRevision: number;
  title: string;
  shortTitle?: string;
  description: string;
  hashtags?: string[];
}
export interface DouyinBatchInput {
  platform?: PublishPlatform;
  requestKey: string;
  accountId: string;
  entries: DouyinQueueEntry[];
}
export interface DouyinQueueRow {
  platform?: SocialPlatform;
  createdAt?: string;
  checkedAt?: string;
  sourceWorkId?: string;
  sourceCommentId?: string;
  kind?: "video" | "message";
  eligibleAt?: number;
  artifactId?: string;
  title: string;
  errorMessage?: string;
  messageSteps?: DouyinMessageStepLog[];
  resultSource?: "platform" | "manual";
  id: string;
  batchId: string;
  accountId: string;
  state: DouyinPublishState | "queued" | "interrupted";
  recordId?: string;
  errorCode?: string;
  progress?: number;
}
export interface DouyinQueue {
  paused: boolean;
  messageResumeAvailable?: boolean;
  rows: DouyinQueueRow[];
}
export const douyinStateLabels: Record<DouyinPublishState, string> = {
  running: "正在上传",
  submitting: "正在提交",
  accepted: "已提交抖音",
  failed: "发布失败",
  unknown: "结果待核对",
  canceled: "已取消",
};
export function douyinRecordLabel(
  record: Pick<DouyinPublishRecord, "state" | "resultSource" | "platform"> & {
    scheduledAt?: number | null;
  },
): string {
  if (record.state === "accepted") {
    if (record.resultSource === "manual") return "已发布";
    if (record.scheduledAt) return "已排期";
    if (record.platform === "channels") return "已提交视频号";
  }
  return douyinStateLabels[record.state];
}

export function formatDouyinSchedule(seconds: number): string {
  const time = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return time.format(seconds * 1000);
}

export function validateDouyinSchedule(
  seconds: number,
  now = Date.now() / 1000,
): string | undefined {
  if (!Number.isSafeInteger(seconds) || seconds % 60 !== 0)
    return "请选择有效的预约日期和时间";
  if (seconds < now + 2 * 3600) return "定时发布时间须至少提前 2 小时";
  if (seconds > now + 14 * 86400) return "定时发布时间不能超过 14 天";
}

export function validatePublishSchedule(
  platform: PublishPlatform,
  seconds: number,
  now = Date.now() / 1000,
): string | undefined {
  if (platform === "channels") {
    if (seconds % 3600 !== 0) return "微信视频号仅支持北京时间整点发布";
    if (seconds <= now + 7200) return "微信视频号定时发布须提前超过 2 小时";
  }
  return validateDouyinSchedule(seconds, now);
}

/** Mirrors format_str_for_short_title in the original Channels uploader. */
export function channelsShortTitle(source: string): string {
  const cleaned = source
    .replace(/[^\p{L}\p{N}《》“”:+?%°,]/gu, "")
    .replaceAll(",", " ")
    .trim();
  const chars = Array.from(cleaned);
  if (!chars.length) return "精彩视频内容分享";
  if (chars.length < 7)
    return [...chars, ..."，精彩内容分享"].slice(0, 7).join("");
  return chars.slice(0, 15).join("");
}

export function channelsShortTitleIssue(shortTitle?: string): string | null {
  if (shortTitle === undefined) return null;
  if (
    typeof shortTitle !== "string" ||
    !/^[\p{L}\p{N}《》“”:+?%°]{7,15}$/u.test(shortTitle)
  )
    return "短标题须为 7 至 15 个字符，可使用文字、数字及《》“”:+?%°";
  return null;
}

export function channelsDescription(
  title: string,
  description: string,
  hashtags: string[],
): string {
  const topics = hashtags.map((tag) => `#${tag.replace(/^#/, "")} `).join("");
  return `${title}\n${topics}\n${description}`;
}

/** OpenCLI counts UTF-16 code units. Keep UI, Main and Go aligned, including emoji. */
export function douyinCaption(description: string, hashtags: string[]): string {
  return [
    description.trim(),
    ...hashtags.map((tag) => `#${tag.replace(/^#+/, "").trim()}`),
  ]
    .filter(Boolean)
    .join(" ");
}
export function validateDouyinInput(
  input: Pick<
    DouyinPublishInput,
    "platform" | "title" | "shortTitle" | "description" | "hashtags"
  >,
): string | undefined {
  if (input.shortTitle !== undefined) {
    if (input.platform !== "channels") return "只有微信视频号支持短标题";
    const issue = channelsShortTitleIssue(input.shortTitle);
    if (issue) return issue;
  }
  if (
    typeof input.title !== "string" ||
    !input.title.trim() ||
    input.title.length > 30
  )
    return "标题不能为空且最多 30 字符";
  if (typeof input.description !== "string" || !Array.isArray(input.hashtags))
    return "正文或话题格式无效";
  if (
    input.hashtags.length > 30 ||
    input.hashtags.some(
      (tag) =>
        typeof tag !== "string" ||
        tag.replace(/^#/, "").length > 100 ||
        !/^#?[^\s#\u0000-\u001f]{1,100}$/u.test(tag),
    )
  )
    return "话题格式无效";
  if (douyinCaption(input.description, input.hashtags).length > 1000)
    return "正文与话题合计最多 1000 字符";
  if (
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(
      input.title + input.description,
    )
  )
    return "文案包含无效字符";
  return undefined;
}
