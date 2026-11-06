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
  id: "script" | "tts" | "avatar";
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
