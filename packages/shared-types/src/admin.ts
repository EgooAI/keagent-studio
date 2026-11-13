import type {
  ProductionTask,
  Resource,
  Stage,
  TaskStatus,
  VideoMode,
} from "./index";

export interface AdminList<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}
export interface AdminIdentity {
  id: string;
  name: string;
  email: string;
}
export interface AdminUser extends AdminIdentity {
  role: string;
  banned: boolean;
  banReason?: string | null;
  createdAt: string;
}
export interface AdminDevice {
  id: string;
  ownerId: string;
  owner: AdminIdentity | null;
  name: string;
  platform: string;
  revoked: boolean;
  lastSeenAt: string;
}
export interface AdminTaskSummary {
  id: string;
  ownerId: string;
  owner: AdminIdentity | null;
  propertyId: string;
  propertyTitle: string;
  propertyNumber: string;
  batchId: string;
  videoMode: VideoMode;
  stage: Stage;
  status: TaskStatus;
  progress: number;
  createdAt: string;
  error?: string;
}
export interface AdminTaskDetail {
  ownerId: string;
  owner: AdminIdentity | null;
  task: ProductionTask;
}
export interface AdminAudit {
  id: string;
  actorId: string;
  actor: AdminIdentity | null;
  targetId: string;
  target: AdminIdentity | null;
  targetLabel: string;
  action: string;
  createdAt: string;
  operationId?: string;
  status?: string;
  reason?: string;
  details: Record<string, string>;
}
export interface AdminAIService {
  id: "script" | "tts" | "voice-clone" | "beike" | "opening";
  label: string;
  purpose: string;
  provider: string;
  model: string;
  endpoint: string;
  state: "missing" | "incomplete" | "configured";
  missing: string[];
  issues: string[];
  note: string;
}
export interface AdminAIConfig {
  configured: boolean;
  model: string;
  baseURL: string;
  note: string;
  checkedAt: string;
  services: AdminAIService[];
  writable: boolean;
  voices: { id: string; name: string }[];
  management: AdminAIManagement[];
}
export type AdminAIProbeMode = "connection" | "sample" | "training";
export type AdminAIProbeStatus =
  "queued" | "running" | "passed" | "failed" | "unknown";
export interface AdminAIProbe {
  id: string;
  service: AdminAIService["id"];
  version: number;
  mode: AdminAIProbeMode;
  status: AdminAIProbeStatus;
  createdAt: string;
  finishedAt: string | null;
  steps: { name: string; state: AdminAIProbeStatus }[];
  message?: string;
  category?: string;
}
interface AdminAIValues {
  version: number;
  fields: Record<string, string | boolean>;
  secrets: Record<string, boolean>;
  test: AdminAIProbe | null;
}
export interface AdminAIManagement {
  summary: AdminAIService;
  group: string;
  revision: number;
  fields: {
    key: string;
    label: string;
    kind: "url" | "text" | "secret" | "toggle";
  }[];
  active: AdminAIValues & {
    source: "environment" | "managed";
    activatedAt: string | null;
    locked: boolean;
  };
  candidate: (AdminAIValues & { missing: string[]; issues: string[] }) | null;
  canActivate: boolean;
}
export interface AdminOverview {
  users: number;
  devices: number;
  publishedResources: number;
  failedTasks: number;
  recentFailedTasks: AdminTaskSummary[];
  services: AdminAIService[];
}
export interface AdminListTypes {
  users: AdminUser;
  devices: AdminDevice;
  resources: Resource;
  tasks: AdminTaskSummary;
  audit: AdminAudit;
  "auth-audit": AdminAudit;
}
