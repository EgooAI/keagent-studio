import { useRef, useState } from "react";
import { App } from "antd";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { createAuthClient } from "@app/auth-sdk/react";
import { adminClient } from "@app/auth-sdk/client/plugins";
import { authBaseURL, serviceRequest } from "@keagent/api-client";
import type {
  AdminIdentity,
  AdminList,
  AdminListTypes,
  CatalogKind,
} from "@keagent/shared-types";

export const auth = createAuthClient({
  baseURL: authBaseURL || undefined,
  plugins: [adminClient({ auditLog: true })],
});

export async function unwrap<T>(
  request: Promise<{ data: T | null; error: { message?: string } | null }>,
): Promise<T> {
  const result = await request;
  if (result.error || result.data === null)
    throw new Error(result.error?.message || "请求失败，请重试");
  return result.data;
}

export function useAdminParams() {
  const [params, update] = useSearchParams();
  function setParams(
    patch: Record<string, string | undefined>,
    resetPage = true,
  ) {
    update((current) => {
      const next = new URLSearchParams(current);
      if (resetPage) next.delete("offset");
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined || value === "") next.delete(key);
        else next.set(key, value);
      }
      return next;
    });
  }
  return { params, setParams };
}

const filters: Record<keyof AdminListTypes, string[]> = {
  users: ["q", "role", "banned"],
  devices: ["q", "ownerId", "revoked"],
  resources: ["q", "state"],
  tasks: ["q", "ownerId", "status", "stage"],
  audit: ["q", "actorId", "targetId", "action", "from", "to"],
  "auth-audit": ["q", "actorId", "targetId", "action", "status", "from", "to"],
};

export function useAdminList<K extends keyof AdminListTypes>(
  kind: K,
  catalog?: CatalogKind,
) {
  const { params } = useAdminParams();
  const query = new URLSearchParams({
    limit: params.get("limit") || "20",
    offset: params.get("offset") || "0",
  });
  if (kind === "resources") {
    if (catalog) query.set("catalog", catalog);
    else query.set("productionOnly", "true");
  }
  for (const key of filters[kind]) {
    const value = params.get(key);
    if (value) query.set(key, value);
  }
  return useQuery({
    queryKey: ["admin", kind, query.toString()],
    queryFn: () =>
      serviceRequest<AdminList<AdminListTypes[K]>>(
        `/v1/admin/${kind}/list?${query}`,
      ),
  });
}

export function listPagination(
  data: AdminList<unknown> | undefined,
  params: URLSearchParams,
  setParams: (
    patch: Record<string, string | undefined>,
    resetPage?: boolean,
  ) => void,
) {
  const limit = data?.limit || Number(params.get("limit")) || 20;
  return {
    current:
      Math.floor(
        (data?.offset ?? (Number(params.get("offset")) || 0)) / limit,
      ) + 1,
    pageSize: limit,
    total: data?.total || 0,
    showSizeChanger: true,
    pageSizeOptions: [20, 50, 100],
    showTotal: (total: number) => `共 ${total} 条`,
    onChange: (page: number, pageSize: number) =>
      setParams(
        { limit: String(pageSize), offset: String((page - 1) * pageSize) },
        false,
      ),
  };
}

export function dateTime(value?: string | null) {
  if (!value) return "未记录";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "时间不可用";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    dateStyle: "short",
    timeStyle: "medium",
    hour12: false,
  }).format(date);
}

export function userLabel(user: AdminIdentity | null | undefined, id?: string) {
  return user
    ? `${user.name || "未命名用户"}（${user.email}）`
    : id
      ? `用户不存在（${id}）`
      : "用户不存在";
}

export function roleLabel(role: string) {
  return role
    .split(",")
    .map((value) =>
      value === "admin" ? "管理员" : value === "user" ? "普通用户" : "其他角色",
    )
    .join("、");
}

export function useAdminAction() {
  const { message } = App.useApp();
  const client = useQueryClient();
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  async function run(fn: () => Promise<unknown>, success = "操作已完成") {
    if (locked.current) return false;
    locked.current = true;
    setBusy(true);
    try {
      await fn();
      if (success) message.success(success);
      await client.invalidateQueries({ queryKey: ["admin"] });
      return true;
    } catch (error) {
      message.error(
        error instanceof Error ? error.message : "操作失败，请重试",
      );
      return false;
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  return { busy, run };
}
