import { PublishingError } from "./core";

export const GENERIC_DESKTOP_ERROR =
  "桌面发布操作失败，请检查登录、文件与网络后重试";

const actionableCodes = new Set([
  "COMMENT_AI_UNAVAILABLE",
  "CONSENT_REQUIRED",
  "CONSENT_REVOKED",
  "COMMENT_PURPOSE_DENIED",
  "COMMENT_NOT_QUALIFIED",
  "ACCOUNT_UNAVAILABLE",
  "INVALID_INPUT",
]);

export function desktopErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (!message.trim()) return GENERIC_DESKTOP_ERROR;
  if (error instanceof PublishingError) return message;
  const rawCode = (error as { code?: unknown } | null)?.code;
  const code = typeof rawCode === "string" ? rawCode : "";
  return actionableCodes.has(code) ||
    code.startsWith("OUTREACH_") ||
    code.startsWith("CREATORHUB_")
    ? message
    : GENERIC_DESKTOP_ERROR;
}
