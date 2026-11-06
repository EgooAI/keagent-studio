import { ServiceRequestError } from "@keagent/api-client";
import type { MediaAsset, VideoArtifact } from "@keagent/shared-types";
async function native<T>(method: string, input: unknown): Promise<T> {
  if (!window.desktop?.artifactMedia)
    throw new ServiceRequestError(
      "请使用桌面客户端登记和恢复成片文件",
      409,
      "DESKTOP_REQUIRED",
    );
  const response = (await window.desktop.artifactMedia.request(
    method,
    input,
  )) as {
    ok: boolean;
    data: T;
    error?: { message: string; code?: string; status: number };
  };
  if (!response.ok)
    throw new ServiceRequestError(
      response.error?.message || "成片文件操作失败",
      response.error?.status || 0,
      response.error?.code,
    );
  return response.data;
}
export const artifactMedia = {
  registerOutput: (jobId: string) =>
    native<VideoArtifact>("producer.register", { jobId }),
  restore: (assetId: string) =>
    native<MediaAsset>("asset.restore", { assetId }),
};
