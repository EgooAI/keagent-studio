/** Publishing owns these records; the immutable artifact contract stays unchanged. */
export type DouyinPublishState =
  "running" | "submitting" | "accepted" | "failed" | "unknown" | "canceled";
export interface DouyinAccount {
  id: string;
  deviceId: string;
  name: string;
  platformUserId?: string;
  loginStatus: string;
  lastCheckedAt: string;
  unboundAt?: string;
}
export interface DouyinPublishInput {
  requestKey: string;
  handoffId: string;
  accountId: string;
  title: string;
  description: string;
  hashtags: string[];
  coverRef?: string;
}
export interface DouyinPublishLog {
  step: string;
  status: "started" | "completed" | "failed";
  timestamp: string;
  durationMs?: number;
  errorCode?: string;
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
export interface DouyinBrowserTab {
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
  activeRecord?: DouyinPublishRecord;
}
export const douyinStateLabels: Record<DouyinPublishState, string> = {
  running: "正在上传",
  submitting: "正在提交",
  accepted: "已提交抖音",
  failed: "发布失败",
  unknown: "结果待核对",
  canceled: "已取消",
};
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
  input: Pick<DouyinPublishInput, "title" | "description" | "hashtags">,
): string | undefined {
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
