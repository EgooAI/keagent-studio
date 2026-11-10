import type {
  PanoramaCapabilities,
  PanoramaConfig,
  PanoramaDraft,
  PanoramaJob,
  Property,
} from "@keagent/shared-types";
import { request } from "./panoramaClient";

export interface FactoryTemplate {
  id: string;
  version: string;
  name: string;
  description?: string;
  opening?: "minimax";
  config: Pick<
    PanoramaConfig,
    "language" | "videoMode" | "aspectRatio" | "resolution"
  >;
}

export type FactoryOpeningClip = {
  id: string;
  name: string;
  duration: number;
  bytes?: number;
};
export type FactoryOpeningPhoto = Pick<FactoryOpeningClip, "id" | "name">;

export type FactoryCatalog = Omit<PanoramaCapabilities, "templates"> & {
  templates: FactoryTemplate[];
  openingClip?: FactoryOpeningClip;
  openingPhoto?: FactoryOpeningPhoto;
};
export type FactoryProperty = Pick<
  Property,
  | "id"
  | "title"
  | "community"
  | "propertyNumber"
  | "district"
  | "layout"
  | "areaSqm"
  | "image"
  | "importStatus"
  | "sample"
>;
export type FactoryProperties = {
  rows: FactoryProperty[];
  total: number;
  page: number;
  districts: string[];
  defaults?: {
    videoTemplate?: { id: string; version: string };
    voiceId?: string;
  };
};
export type FactoryPhase = keyof typeof phaseLabel;
export const phaseLabel = {
  pending: "待准备",
  preparing: "准备文案",
  review: "待审核",
  queued: "排队中",
  running: "制作中",
  done: "已成片",
  archiving: "正在归档",
  archived: "已进入发布中心",
  archiveFailed: "归档失败",
  failed: "制作失败",
  canceled: "已取消",
};
export type FactoryRow = {
  id: string;
  batchId?: string;
  propertyId: string;
  propertyTitle: string;
  propertyNumber?: string;
  templateName: string;
  templateVersion?: string;
  phase: FactoryPhase;
  createdAt: string;
  progress: number;
  stage?: PanoramaJob["stage"];
  error?: string;
  revision?: number;
  started?: boolean;
  artifactId?: string;
};
export type FactoryDetail = FactoryRow & {
  config: PanoramaConfig;
  draft?: PanoramaDraft;
  job?: PanoramaJob;
  legacy?: boolean;
  openingLocationUrl?: string;
  openingLocations?: { asset: string; label: string; url: string }[];
};
export type FactoryList = {
  rows: FactoryRow[];
  total: number;
  page: number;
  counts: Record<string, number>;
  batches: { id: string; createdAt: string; count: number }[];
  paused: boolean;
  interrupted: number;
  storageError?: string;
  nextReviewId?: string;
  focused?: FactoryRow;
};
export type FactoryAction =
  | "confirm"
  | "withdraw"
  | "cancel"
  | "retry"
  | "copy"
  | "archive"
  | "edit-opening"
  | "room-opening";
export type FactoryActionResult = {
  id: string;
  ok: boolean;
  error?: string;
  createdId?: string;
};
export type FactoryPair = {
  propertyId: string;
  templateId: string;
  version: string;
};
export type FactoryIssue = FactoryPair & {
  propertyTitle?: string;
  templateName?: string;
  error: string;
};
export const pairKey = ({ propertyId, templateId, version }: FactoryPair) =>
  JSON.stringify([propertyId, templateId, version]);
export const templateKey = (t: Pick<FactoryTemplate, "id" | "version">) =>
  JSON.stringify([t.id, t.version]);
export const factoryRequest = <T>(method: string, input?: unknown) =>
  request<T>("factory-" + method, input);
