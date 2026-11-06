export interface PanoramaConfig {
  materialMode?: "panorama" | "expand";
  templateId: string;
  language: "zh-CN" | "en-US";
  scriptProvider: "template" | "ai";
  openingTemplate: string;
  sceneTemplate: string;
  closingTemplate: string;
  videoMode: "voiceover" | "avatar";
  ttsProvider: "system" | "volcengine" | "personal";
  voice: string;
  rate: number;
  avatarId: string;
  speed: number;
  direction: 1 | -1;
  maxSweep: number;
  aspectRatio: "9:16" | "16:9";
  resolution: "720p" | "1080p";
  subtitles: boolean;
  design?: "standard" | "classic";
  brandColor?: string;
  subtitleSize?: "standard" | "large";
  leadSceneId?: string;
  coverSceneId?: string;
  coverTitle?: string;
  agentName?: string;
  agentContact?: string;
}
export interface PanoramaTemplate {
  id: string;
  name: string;
  version: number;
  config: Partial<PanoramaConfig>;
  updatedAt: string;
}
export interface PanoramaScene {
  kind?: "panorama" | "photo" | "expanded";
  approved?: boolean;
  sourceAsset?: string;
  id: string;
  asset: string;
  room: string;
  description: string;
  yaw: number;
  direction?: 1 | -1;
  url?: string;
}
export interface PanoramaSegment {
  id: string;
  kind: "opening" | "scene" | "closing";
  sceneId: string;
  text: string;
}
export interface PanoramaProperty {
  id: string;
  title: string;
  description: string;
  areaSqm: number;
  priceCents: number;
  layout: string;
  sellingPoints: string[];
  sample?: boolean;
}
export interface PanoramaDraft {
  templateVersion?: string;
  id: string;
  revision: number;
  property: PanoramaProperty;
  sample: boolean;
  config: PanoramaConfig;
  scenes: PanoramaScene[];
  segments: PanoramaSegment[];
  createdAt: string;
}
export interface PanoramaJob extends Omit<PanoramaDraft, "revision"> {
  draftId: string;
  draftRevision: number;
  status: "running" | "succeeded" | "failed" | "canceled";
  stage: "tts" | "avatar" | "render" | "cover";
  progress: number;
  error?: string;
  videoUrl?: string;
  coverUrl?: string;
  audioUrl?: string;
  duration?: number;
  completedAt?: string;
  timeline?: {
    id: string;
    sceneId: string;
    start: number;
    duration: number;
    camera: { start: number; end: number; sweep: number } | null;
  }[];
  avatar?: { key: string; taskId?: string; submitting?: boolean };
}
export interface PanoramaState {
  templates?: PanoramaTemplate[];
  properties?: PanoramaProperty[];
  imageTasks?: {
    id: string;
    sceneId: string;
    status: string;
    error?: string;
  }[];
  drafts: PanoramaDraft[];
  jobs: PanoramaJob[];
}
export interface PanoramaCapabilities {
  beike?: boolean;
  imageExpansion?: boolean;
  ffmpeg: boolean;
  ffprobe: boolean;
  voices: { name: string; language: string }[];
  ai: boolean;
  volcTts: boolean;
  volcAvatar: boolean;
  managedVoices: boolean;
  defaultConfig: PanoramaConfig;
  templates: {
    id: string;
    version: string;
    name: string;
    opening: string;
    scene: string;
    closing: string;
  }[];
}
