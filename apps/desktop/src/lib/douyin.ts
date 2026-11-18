import { useEffect } from "react";
import type { CommentPanelStatus } from "@keagent/shared-types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  douyinApi,
  douyinDesktop,
  ServiceRequestError,
} from "@keagent/api-client";
export { douyinApi, douyinDesktop };
export const panelLabels: Record<CommentPanelStatus, string> = {
  not_checked: "未检查",
  visible: "可见",
  explicitly_empty: "明确为空",
  not_visible: "当前视口不可见",
  loading: "加载中",
  load_failed: "加载失败",
  restricted: "访问受限",
  unknown: "无法判断",
};
export function publishingFailureText(code: string): string {
  const labels: Record<string, string> = {
    EXECUTION_FAILED: "发布执行失败，请查看账号浏览器后重新操作。",
    VIDEO_UPLOAD_FAILED: "抖音网页报告视频上传失败，请查看账号浏览器中的提示。",
    VIDEO_UPLOAD_TIMEOUT:
      "等待抖音网页完成上传超时，请查看账号浏览器中的进度。",
    COVER_UPLOAD_FAILED:
      "抖音未确认封面上传，发布已停止。请检查成片封面及执行步骤。",
    PUBLISH_TEXT_MISMATCH: "抖音网页中的文案与任务不一致，已停止提交。",
    LOGIN_REQUIRED: "抖音登录已失效，请重新登录后再发布。",
    ASSET_UNAVAILABLE: "本机成片文件不可用，请恢复文件后重试。",
    ASSET_CHANGED: "本机文件与验收版本不一致，请重新检查成片。",
    REVISION_CONFLICT: "验收状态已变化，请重新检查成片。",
    NOT_APPROVED: "成片尚未通过验收或验收已撤回。",
    CONTENT_REJECTED: "内容预检未通过，请检查并修改发布内容。",
    PRECHECK_FAILED: "抖音未能完成内容预检，请在创作者中心检查后再试。",
    PRECHECK_TIMEOUT: "平台内容预检超时，请稍后重新操作。",
    PLATFORM_REJECTED: "抖音拒绝了本次提交，请检查内容与登录状态。",
    PUBLISH_OUTCOME_UNKNOWN: "提交结果暂时无法确认，请先到创作者中心核对。",
    USER_CONFIRMED_NOT_PUBLISHED: "你已确认该视频未发布，可以重新操作。",
    INTERRUPTED: "发布过程已中断，请检查账号和文件后重新操作。",
    SESSION_CHANGED: "应用登录状态已变化，本次操作已停止。",
    ACCOUNT_CHANGED: "浏览器内的抖音账号已改变，请重新添加账号。",
    ACCOUNT_NOT_SAVED: "请先在账号浏览器点击保存账号。",
    ACCOUNT_UNAVAILABLE: "发布账号不可用，请检查抖音账号是否已登录并保存。",
    ARTIFACT_ALREADY_SUBMITTED: "该成片已有发布提交或正在执行，已跳过。",
    OUTCOME_UNRESOLVED: "这份成片上次的发布结果待核对，请在详情中检查。",
  };
  return labels[code] || "发布未完成，请查看执行步骤或联系管理员。";
}
export function publishingMessage(error: unknown): string {
  if (error instanceof ServiceRequestError) {
    const messages: Record<string, string> = {
      RESOLVER_UNAVAILABLE:
        "制作侧本机文件解析器尚未接入。可以查看成片信息，真实预览与发布将在接入后启用。",
      WRONG_DEVICE: "请在持有成片与账号的原设备操作。",
      REVISION_CONFLICT: "验收状态已变化，请重新打开预览验收。",
      ASSET_UNAVAILABLE: "本机文件不可用，请在「更多」中恢复文件后再试。",
      IDEMPOTENCY_CONFLICT: "请求键已用于另一操作，请核对上次提交。",
      OUTCOME_UNRESOLVED: "请先核对这份成片上次发布的未知结果。",
      LOGIN_REQUIRED: "请打开账号浏览器完成登录或人工验证。",
    };
    return messages[error.code || ""] || error.message;
  }
  return error instanceof Error ? error.message : "操作失败，请重试";
}
export const desktopPublishingAvailable = () => !!window.desktop?.publishing;
export function useDouyinDesktop(subscribe = true) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["douyin", "desktop"],
    queryFn: douyinApi.state,
    enabled: desktopPublishingAvailable(),
    refetchInterval: 10000,
    retry: false,
  });
  useEffect(() => {
    if (!subscribe) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = window.desktop?.publishing?.subscribe(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        void client.invalidateQueries({ queryKey: ["douyin"] });
      }, 300);
    });
    return () => {
      clearTimeout(timer);
      unsubscribe?.();
    };
  }, [client, subscribe]);
  return query;
}
