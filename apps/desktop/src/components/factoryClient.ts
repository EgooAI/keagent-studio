import type {
  BackgroundMusicSelection,
  PanoramaCapabilities,
  PanoramaConfig,
  PanoramaDraft,
  PanoramaJob,
  Property,
  CoverTemplate,
  EditTemplate,
  TemplatePartOption,
  TemplatePartKind,
  TemplateBundle,
} from "@keagent/shared-types";
import { request } from "./panoramaClient";

export interface FactoryTemplate {
  id: string;
  version: string;
  name: string;
  description?: string;
  config: Pick<
    PanoramaConfig,
    | "language"
    | "videoMode"
    | "aspectRatio"
    | "resolution"
    | "speed"
    | "rate"
    | "maxSweep"
    | "design"
    | "cameraMode"
  >;
}

export type FactoryOpeningClip = {
  id: string;
  name: string;
  duration: number;
  url?: string;
};

export type FactoryCatalog = Omit<PanoramaCapabilities, "templates"> & {
  templates: FactoryTemplate[];
  library?: FactoryLibrary;
};
export type FactoryBundle = {
  id: string;
  name: string;
  version: string;
  description?: string;
  thumbnail?: string;
  parts: TemplateBundle["parts"];
  backgroundMusic?: BackgroundMusicSelection;
};
export type FactoryPart = TemplatePartOption & {
  available: boolean;
  description?: string;
  cover?: CoverTemplate;
  config?: EditTemplate["config"];
  language?: PanoramaConfig["language"];
};
export type FactoryLibrary = {
  recommended: FactoryBundle[];
  personal: FactoryBundle[];
  parts: FactoryPart[];
};
export const partKinds: TemplatePartKind[] = ["edit", "cover", "script"];
export const partLabel = {
  edit: "剪辑模板",
  cover: "封面模板",
  script: "文案模板",
};
export function matchesMix(a: FactoryBundle, b: FactoryBundle) {
  return (
    a.id === b.id &&
    a.version === b.version &&
    a.backgroundMusic?.id === b.backgroundMusic?.id &&
    a.backgroundMusic?.volume === b.backgroundMusic?.volume &&
    partKinds.every(
      (kind) => templateKey(a.parts[kind]) === templateKey(b.parts[kind]),
    )
  );
}
export function partFor(
  parts: FactoryPart[],
  bundle: FactoryBundle,
  kind: TemplatePartKind,
) {
  const ref = bundle.parts[kind];
  return parts.find(
    (part) =>
      part.kind === kind && part.id === ref.id && part.version === ref.version,
  );
}
export function mixTemplate(
  parts: FactoryPart[],
  bundle: FactoryBundle,
): FactoryTemplate | undefined {
  const edit = partFor(parts, bundle, "edit");
  const script = partFor(parts, bundle, "script");
  const cover = partFor(parts, bundle, "cover");
  if (
    !edit?.available ||
    !edit.config ||
    !script?.available ||
    !script.language ||
    !cover?.available ||
    !cover.cover
  )
    return;
  return {
    id: bundle.id,
    version: bundle.version,
    name: bundle.name,
    description: bundle.description,
    config: { ...edit.config, language: script.language },
  };
}
export function mixRequest(bundle: FactoryBundle) {
  const { id, version, parts } = bundle;
  return {
    id,
    version,
    parts: Object.fromEntries(
      partKinds.map((kind) => [
        kind,
        { id: parts[kind].id, version: parts[kind].version },
      ]),
    ),
  };
}
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
  openingVideoUrl?: string;
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
