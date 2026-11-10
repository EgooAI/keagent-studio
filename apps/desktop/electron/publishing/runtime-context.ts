import { AsyncLocalStorage } from "node:async_hooks";
import type { ExecutionStepReporter } from "./runtime/task-executor/execution-log";
import { PublishingError } from "./core";
export interface UploadContext {
  fetch: typeof fetch;
  signal: AbortSignal;
  beforeSubmit: () => Promise<void>;
  progress: (value: number) => void;
  steps: ExecutionStepReporter;
  assetHash: string;
  accountId: string;
}
const context = new AsyncLocalStorage<UploadContext>();
export function withUploadContext<T>(
  value: UploadContext,
  action: () => Promise<T>,
): Promise<T> {
  return context.run(value, action);
}
export function uploadContext(): UploadContext {
  const value = context.getStore();
  if (!value) throw new Error("Publish transport must be injected");
  value.signal.throwIfAborted();
  return value;
}
export function allowedUploadUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      [
        "bytedanceapi.com",
        "douyin.com",
        "volces.com",
        "byteimg.com",
        "douyinvod.com",
        "bytedance.com",
        "snssdk.com",
        "ibytedtos.com",
        "bytecdn.cn",
      ].some(
        (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
      )
    );
  } catch {
    return false;
  }
}
export async function uploadFetch(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const current = uploadContext();
  if (!allowedUploadUrl(url))
    throw new PublishingError(
      "UPLOAD_HOST_REJECTED",
      "平台返回了未支持的上传地址",
    );
  const headers = new Headers(init.headers);
  // Chromium derives these from the URL and body and rejects explicit values.
  headers.delete("host");
  headers.delete("content-length");
  return current.fetch(url, {
    ...init,
    headers,
    redirect: "error",
    credentials: "omit",
    signal: init.signal
      ? AbortSignal.any([current.signal, init.signal])
      : current.signal,
  });
}
export function progress(uploaded: number, total: number): void {
  uploadContext().progress(Math.round((uploaded / total) * 85));
}
export function warnPrecheck(): void {
  uploadContext().steps.record(
    "completed",
    "safety_precheck_unavailable",
    "平台预检不可用，提交后仍由平台审核",
  );
}
