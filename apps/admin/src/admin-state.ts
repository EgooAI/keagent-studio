import { useState } from "react";

export interface Release {
  id: string;
  version: string;
  platform: string;
  fileName: string;
  published: boolean;
  createdAt: string;
}
interface AdminState {
  schemaVersion: 1;
  userEnabled: boolean;
  deviceBound: boolean;
  ai: {
    textProvider: string;
    textModel: string;
    ttsProvider: string;
    avatarProvider: string;
    endpoint: string;
  };
  releases: Release[];
  flags: { avatar: boolean; publishing: boolean; leadAnalysis: boolean };
  audit: { id: string; action: string; at: string }[];
}
const key = "keagent.admin.demo.v1";
const initial: AdminState = {
  schemaVersion: 1,
  userEnabled: true,
  deviceBound: true,
  ai: {
    textProvider: "演示文案服务",
    textModel: "Mock script model",
    ttsProvider: "演示语音服务",
    avatarProvider: "演示数字人服务",
    endpoint: "",
  },
  releases: [
    {
      id: "release-demo",
      version: "0.1.0",
      platform: "Windows x64",
      fileName: "KeAgent-Studio-0.1.0.exe（示例）",
      published: false,
      createdAt: "2026-10-30T08:00:00Z",
    },
  ],
  flags: { avatar: true, publishing: true, leadAnalysis: true },
  audit: [],
};

function read(): AdminState {
  const raw = localStorage.getItem(key);
  if (!raw) return structuredClone(initial);
  const saved = JSON.parse(raw) as AdminState;
  if (
    !saved ||
    saved.schemaVersion !== 1 ||
    typeof saved.userEnabled !== "boolean" ||
    typeof saved.deviceBound !== "boolean" ||
    !saved.ai ||
    !(
      [
        "textProvider",
        "textModel",
        "ttsProvider",
        "avatarProvider",
        "endpoint",
      ] as const
    ).every((field) => typeof saved.ai[field] === "string") ||
    !saved.flags ||
    !(["avatar", "publishing", "leadAnalysis"] as const).every(
      (field) => typeof saved.flags[field] === "boolean",
    ) ||
    !Array.isArray(saved.releases) ||
    !saved.releases.every(
      (row) =>
        row &&
        ["id", "version", "platform", "fileName", "createdAt"].every(
          (field) => typeof row[field as keyof Release] === "string",
        ) &&
        typeof row.published === "boolean",
    ) ||
    !Array.isArray(saved.audit) ||
    !saved.audit.every(
      (row) =>
        row &&
        typeof row.id === "string" &&
        typeof row.action === "string" &&
        typeof row.at === "string",
    )
  )
    throw new Error(
      "后台演示数据格式不兼容。原数据未清除，请先备份，再清理该站点的后台演示数据。",
    );
  return saved;
}

export function useAdminState() {
  const [state, setState] = useState<AdminState>(() => read());
  function update(patch: Partial<AdminState>, action: string) {
    const next: AdminState = {
      ...state,
      ...patch,
      audit: [
        { id: crypto.randomUUID(), action, at: new Date().toISOString() },
        ...state.audit,
      ].slice(0, 100),
    };
    localStorage.setItem(key, JSON.stringify(next));
    setState(next);
  }
  return { state, update };
}
