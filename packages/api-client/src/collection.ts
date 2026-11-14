import type {
  CollectionPage,
  CollectionRun,
  CollectionTarget,
  CollectionTargetInput,
  MonitoredVideo,
} from "@keagent/shared-types";
import { desktopCloud, douyinDesktop } from "./douyin";

function collectionCloud<T>(operation: string, input: unknown) {
  return desktopCloud<T>("collection", operation, input);
}

interface PageInput {
  cursor?: string;
  limit?: number;
}
interface HistoryInput extends PageInput {
  targetId?: string;
}

export const collectionApi = {
  targets: (input: PageInput = {}) =>
    collectionCloud<CollectionPage<CollectionTarget>>("targets/list", input),
  target: (id: string) =>
    collectionCloud<CollectionTarget>("targets/get", { id }),
  createTarget: (input: CollectionTargetInput & { requestKey: string }) =>
    collectionCloud<CollectionTarget>("targets/create", input),
  updateTarget: (
    input: CollectionTargetInput & { id: string; expectedVersion: number },
  ) => collectionCloud<CollectionTarget>("targets/update", input),
  pauseTarget: (id: string, expectedVersion: number) =>
    collectionCloud<CollectionTarget>("targets/pause", { id, expectedVersion }),
  resumeTarget: (id: string, expectedVersion: number) =>
    collectionCloud<CollectionTarget>("targets/resume", {
      id,
      expectedVersion,
    }),
  archiveTarget: (id: string, expectedVersion: number) =>
    collectionCloud<CollectionTarget>("targets/archive", {
      id,
      expectedVersion,
    }),
  startRun: (targetId: string, expectedVersion: number, requestKey: string) =>
    douyinDesktop<CollectionRun>("collection.start", {
      targetId,
      expectedVersion,
      requestKey,
    }),
  cancelRun: (id: string) =>
    douyinDesktop<CollectionRun>("collection.cancel", { id }),
  runs: (input: HistoryInput = {}) =>
    collectionCloud<CollectionPage<CollectionRun>>("runs/list", input),
  run: (id: string) => collectionCloud<CollectionRun>("runs/get", { id }),
  videos: (input: HistoryInput = {}) =>
    collectionCloud<CollectionPage<MonitoredVideo>>("videos/list", input),
  video: (id: string) => collectionCloud<MonitoredVideo>("videos/get", { id }),
};
