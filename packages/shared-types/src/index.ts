export * from "./douyin";
export * from "./comment-observation";
export type VideoMode = "voiceover" | "avatar";
export type * from "./artifact";
export type * from "./beike";
export type * from "./panorama";
export type * from "./production-template";
export type TaskStatus =
  | "queued"
  | "running"
  | "awaiting_review"
  | "succeeded"
  | "failed"
  | "canceled";
export type Stage =
  "prepare" | "script" | "tts" | "avatar" | "render" | "cover";
export type Platform = "douyin" | "xiaohongshu";
export type PublishStatus =
  | "queued"
  | "running"
  | "draft_saved"
  | "published"
  | "failed"
  | "unknown"
  | "canceled";
export type ResourceType = "video" | "style" | "cover" | "subtitle" | "prompt";
export interface ResourceRef {
  id: string;
  version: string;
}
export interface PropertyDetails {
  floor?: string;
  orientation?: string;
  elevator?: "有" | "无";
  buildingAge?: string;
  transactionAttributes?: string;
  listingStatus?: "在售" | "已成交" | "已下架";
  listingUrl?: string;
  vrUrl?: string;
}
export interface Property {
  sample?: boolean;
  id: string;
  propertyNumber: string;
  title: string;
  city: string;
  district: string;
  community: string;
  priceCents: number;
  areaSqm: number;
  layout: string;
  description: string;
  sellingPoints: string[];
  details?: PropertyDetails;
  image: string;
  images: string[];
  panoramas?: string[];
  videoCount: number;
  importStatus: "ready" | "incomplete";
  lastVerifiedAt: string;
}
export interface Resource {
  id: string;
  name: string;
  description: string;
  type: ResourceType;
  category: string;
  version: string;
  thumbnail: string;
  compatibleModes: VideoMode[];
  installed: boolean;
  downloadStatus: "idle" | "downloading" | "installed" | "failed";
  downloadProgress: number;
  published: boolean;
  sizeMb: number;
  publishedOnce?: boolean;
  production?: import("./production-template").ProductionTemplateRecipe;
  previewed?: boolean;
}
export interface ProductionConfig {
  propertyIds: string[];
  videoMode: VideoMode;
  promptTemplate: ResourceRef;
  videoTemplate: ResourceRef;
  styleTemplate: ResourceRef;
  coverTemplate: ResourceRef;
  subtitleTemplate?: ResourceRef;
  voiceId: string;
  avatarId?: string;
  requireScriptReview: boolean;
  aspectRatio: "9:16" | "16:9";
  outputResolution: "720p" | "1080p";
}
export interface ProductionTask {
  id: string;
  batchId: string;
  propertyId: string;
  propertySnapshot: Property;
  configSnapshot: ProductionConfig;
  status: TaskStatus;
  stage: Stage;
  script: string;
  scriptRevision: number;
  approvedRevision?: number;
  productionRevision: number;
  createdAt: string;
  completedAt?: string;
  error?: string;
  progress: number;
  videoUrl?: string;
  coverUrl?: string;
  history?: {
    revision: number;
    scriptRevision?: number;
    script: string;
    videoUrl?: string;
    coverUrl?: string;
  }[];
}
export interface ProductionBatch {
  id: string;
  configSnapshot: ProductionConfig;
  taskIds: string[];
  createdAt: string;
}
export interface PublishTask {
  id: string;
  productionTaskId: string;
  productionRevision: number;
  platform: Platform;
  accountId: string;
  title: string;
  description: string;
  hashtags: string[];
  status: PublishStatus;
  createdAt: string;
  progress: number;
  error?: string;
  simulateFailure?: boolean;
}
export interface Voice {
  id: string;
  name: string;
  description: string;
  status: "ready" | "processing";
  isDefault: boolean;
}
export interface Avatar {
  id: string;
  name: string;
  image: string;
  status: "ready" | "processing";
  isDefault: boolean;
}
export interface PlatformAccount {
  id: string;
  platform: Platform;
  name: string;
  connected: boolean;
  lastCheckedAt: string;
}
export interface AgentProfile {
  name: string;
  brokerage: string;
  city: string;
  regions: string;
  phone: string;
  introduction: string;
  defaults: ProductionConfig;
}
export interface Lead {
  id: string;
  name: string;
  platform: Platform;
  commentText: string;
  sourceVideo: string;
  intentLevel: "high" | "medium" | "low";
  budget: string;
  region: string;
  housingRequirements: string;
  aiSummary: string;
  contactPermission: string;
  followupStatus: "new" | "contacted" | "following" | "closed";
  reply: string;
  followups: { id: string; note: string; createdAt: string }[];
}
export interface AnalysisJob {
  id: string;
  name: string;
  url: string;
  platform: Platform;
  status: "running" | "succeeded";
  createdAt: string;
}
export interface Workspace {
  schemaVersion: 1;
  properties: Property[];
  resources: Resource[];
  tasks: ProductionTask[];
  batches: ProductionBatch[];
  publishTasks: PublishTask[];
  voices: Voice[];
  avatars: Avatar[];
  accounts: PlatformAccount[];
  profile: AgentProfile;
  draft: ProductionConfig;
  leads: Lead[];
  analysisJobs: AnalysisJob[];
  requests: Record<string, string>;
  updatedAt: string;
}
export interface ImportResult {
  imported: number;
  duplicates: number;
  failed: string[];
  propertyIds: string[];
}
export interface PublishInput {
  accountId: string;
  title: string;
  description: string;
  hashtags: string[];
  simulateFailure?: boolean;
}
export const statusLabels: Record<TaskStatus, string> = {
  queued: "排队中",
  running: "执行中",
  awaiting_review: "待文案审核",
  succeeded: "已完成",
  failed: "失败",
  canceled: "已取消",
};
export const stageLabels: Record<Stage, string> = {
  prepare: "准备素材",
  script: "生成文案",
  tts: "合成配音",
  avatar: "旧版开场",
  render: "视频与字幕合成",
  cover: "生成封面",
};
export const platformLabels: Record<Platform, string> = {
  douyin: "抖音",
  xiaohongshu: "小红书",
};
export const publishLabels: Record<PublishStatus, string> = {
  queued: "待上传",
  running: "上传中",
  draft_saved: "平台草稿",
  published: "已发布",
  failed: "失败",
  unknown: "待确认",
  canceled: "已取消",
};
export type * from "./admin";
export type * from "./voice";
