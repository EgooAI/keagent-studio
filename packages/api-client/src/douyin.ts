import { ServiceRequestError, serviceRequest } from "./transport";
import type {
  DouyinAccount,
  DouyinDesktopState,
  DouyinPublishInput,
  DouyinPublishRecord,
} from "@keagent/shared-types";
declare global {
  interface Window {
    /* Publishing is a bounded preload capability, never a generic Electron bridge. */
  }
}
interface Envelope<T> {
  ok: boolean;
  data: T;
  error?: { message: string; code?: string; status: number };
}
function unwrap<T>(reply: Envelope<T>): T {
  if (!reply.ok)
    throw new ServiceRequestError(
      reply.error?.message || "抖音操作失败",
      reply.error?.status || 0,
      reply.error?.code,
    );
  return reply.data;
}
async function cloud<T>(operation: string, input: unknown = {}): Promise<T> {
  if (window.desktop?.request)
    return unwrap(
      (await window.desktop.request("douyin.cloud", [
        operation,
        input,
      ])) as Envelope<T>,
    );
  return serviceRequest<T>(`/v1/douyin/${operation}`, input);
}
export async function douyinDesktop<T>(
  method: string,
  input: unknown = {},
): Promise<T> {
  if (!window.desktop?.publishing)
    throw new ServiceRequestError(
      "请使用桌面客户端执行此操作",
      409,
      "DESKTOP_REQUIRED",
    );
  return unwrap(
    (await window.desktop.publishing.request(method, input)) as Envelope<T>,
  );
}
export const douyinApi = {
  accounts: () => cloud<{ items: DouyinAccount[] }>("accounts/list"),
  records: (artifactId: string, offset = 0) =>
    cloud<{ items: DouyinPublishRecord[]; total: number }>("records/list", {
      artifactId,
      offset,
      limit: 20,
    }),
  record: (id: string) => cloud<DouyinPublishRecord>("records/get", { id }),
  reconcile: (id: string, published: boolean, url = "") =>
    cloud<DouyinPublishRecord>("records/reconcile", { id, published, url }),
  state: () => douyinDesktop<DouyinDesktopState>("state"),
  start: (input: DouyinPublishInput) =>
    douyinDesktop<DouyinPublishRecord>("publish.start", input),
};
