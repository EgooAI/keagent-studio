import { app, dialog, ipcMain, type BrowserWindow } from "electron";
import path from "node:path";
import {
  ArtifactMediaError,
  LocalMediaRegistry,
  type MediaIdentity,
  type MediaProbe,
} from "./registry";
import {
  ArtifactRegistrationService,
  type CompletedArtifactOutput,
  type RegistryExchange,
} from "./service";
import { probeMedia } from "./probe";
export { LocalMediaRegistry, ArtifactMediaError } from "./registry";
export { ArtifactRegistrationService } from "./service";
export type { CompletedArtifactOutput, RegistryExchange } from "./service";
export type { MediaIdentity, MediaProbe } from "./registry";
export function registerArtifactMedia(
  window: BrowserWindow,
  dependencies: {
    identity: () => Promise<MediaIdentity>;
    exchange: RegistryExchange;
    producer: (jobId: string) => Promise<CompletedArtifactOutput>;
    probe?: MediaProbe;
  },
) {
  const registry = new LocalMediaRegistry(
    path.join(app.getPath("userData"), "artifact-media"),
    dependencies.identity,
    dependencies.probe || probeMedia,
  );
  const service = new ArtifactRegistrationService(
    registry,
    dependencies.exchange,
  );
  ipcMain.handle(
    "artifact-media:request",
    async (event, method: unknown, input: unknown) => {
      try {
        const url = new URL(event.senderFrame?.url || "about:blank");
        const trusted =
          app.isPackaged || process.argv.includes("--built")
            ? url.protocol === "keagent:" && url.hostname === "app"
            : url.origin === "http://127.0.0.1:5173";
        if (
          !trusted ||
          event.sender !== window.webContents ||
          event.senderFrame !== event.sender.mainFrame ||
          !input ||
          typeof input !== "object" ||
          Array.isArray(input) ||
          JSON.stringify(input).length > 4096
        )
          throw new ArtifactMediaError("FORBIDDEN", "非法成片文件请求", 403);
        const identity = await dependencies.identity();
        const value = input as Record<string, unknown>;
        let data: unknown;
        if (method === "producer.register") {
          if (
            Object.keys(value).some((key) => key !== "jobId") ||
            typeof value.jobId !== "string" ||
            !/^[a-f0-9-]{36}$/.test(value.jobId)
          )
            throw new ArtifactMediaError(
              "INVALID_INPUT",
              "制作结果引用无效",
              422,
            );
          const output = await dependencies.producer(value.jobId);
          await registry.assertIdentity(identity);
          data = await service.register(output);
        } else if (method === "asset.restore") {
          if (
            Object.keys(value).some((key) => key !== "assetId") ||
            typeof value.assetId !== "string" ||
            !/^[a-f0-9]{32}$/.test(value.assetId)
          )
            throw new ArtifactMediaError(
              "INVALID_INPUT",
              "成片资产引用无效",
              422,
            );
          const asset = await dependencies.exchange.getAsset(value.assetId);
          if (
            asset.ownerId !== identity.userId ||
            asset.location.deviceId !== identity.deviceId
          )
            throw new ArtifactMediaError(
              "WRONG_DEVICE",
              "请在成片所属设备恢复文件",
            );
          const selected = await dialog.showOpenDialog(window, {
            title: `定位${asset.kind === "video" ? "原始MP4视频" : asset.kind === "cover" ? "原始封面" : "原始字幕"}`,
            properties: ["openFile"],
            filters: [
              {
                name: "原始成片文件",
                extensions:
                  asset.kind === "video"
                    ? ["mp4"]
                    : asset.kind === "cover"
                      ? ["jpg", "jpeg", "png"]
                      : ["vtt", "srt"],
              },
            ],
          });
          await registry.assertIdentity(identity);
          if (selected.canceled || !selected.filePaths[0])
            throw new ArtifactMediaError(
              "SELECTION_CANCELED",
              "已取消定位文件",
            );
          data = await service.restore(asset, selected.filePaths[0]);
        } else
          throw new ArtifactMediaError("INVALID_INPUT", "成片操作未开放", 422);
        await registry.assertIdentity(identity);
        return { ok: true, data };
      } catch (error) {
        const e = error as { code?: string; status?: number; message?: string };
        return {
          ok: false,
          error: {
            code: e.code || "REGISTRATION_FAILED",
            status: e.status || 409,
            message:
              error instanceof ArtifactMediaError
                ? error.message
                : e.code && e.status
                  ? e.message
                  : "成片登记未完成，请检查本机文件与服务连接后重试",
          },
        };
      }
    },
  );
  window.on("closed", () => ipcMain.removeHandler("artifact-media:request"));
  return { registry, service };
}
