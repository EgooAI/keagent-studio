import { PublishingError } from "../publishing/core";

export interface CreatorHubAccount {
  id: number;
  platform: string;
  nickname: string;
  status: string;
  has_read_login: boolean;
}
export interface CreatorHubWatch {
  id: number;
  platform: string;
  kind: string;
  aweme_id: string;
  account_id: number | null;
  title: string;
  group_name: string;
  enabled: boolean;
}
export interface CreatorHubComment {
  comment_id: string;
  text: string;
  user_nickname: string;
  user_sec_uid: string;
  like_count: number;
  create_time: number;
  is_reply: boolean;
}
export interface CreatorHubAction {
  id: number;
  status: string;
  error: string;
}

function loopbackBase(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PublishingError(
      "CREATORHUB_URL_INVALID",
      "CreatorHub 地址必须是本机 HTTP 地址",
      422,
    );
  }
  if (
    url.protocol !== "http:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new PublishingError(
      "CREATORHUB_URL_INVALID",
      "CreatorHub 地址必须是本机 HTTP 地址",
      422,
    );
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    throw new PublishingError(
      "CREATORHUB_URL_INVALID",
      "CreatorHub 地址必须是本机地址",
      422,
    );
  return url;
}

export class CreatorHubClient {
  private base: URL;
  constructor(
    rawBaseUrl: string,
    private fetchImpl: typeof fetch = fetch,
  ) {
    this.base = loopbackBase(rawBaseUrl);
  }
  private async call<T>(
    path: string,
    init: RequestInit = {},
    timeout = 30_000,
  ): Promise<T> {
    let response: Response;
    let text: string;
    try {
      const headers = new Headers(init.headers);
      if (!headers.has("content-type"))
        headers.set("content-type", "application/json");
      response = await this.fetchImpl(new URL(path, this.base), {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(timeout),
        headers,
      });
      text = await response.text();
    } catch (error) {
      const name = (error as { name?: string }).name;
      throw new PublishingError(
        name === "TimeoutError"
          ? "CREATORHUB_TIMEOUT"
          : "CREATORHUB_UNAVAILABLE",
        name === "TimeoutError"
          ? "CreatorHub 响应超时"
          : "无法连接 CreatorHub，请确认服务已启动",
        503,
      );
    }
    if (!response.ok) {
      let detail = "CreatorHub 拒绝了请求";
      try {
        const parsed = JSON.parse(text) as { detail?: unknown } | null;
        if (parsed && typeof parsed === "object" && parsed.detail)
          detail = String(parsed.detail);
      } catch {
        // Keep the generic rejection message for non-JSON error bodies.
      }
      throw new PublishingError("CREATORHUB_REJECTED", detail, response.status);
    }
    if (!text.trim()) return null as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new PublishingError(
        "CREATORHUB_INVALID_RESPONSE",
        "CreatorHub 返回了无法解析的数据",
        502,
      );
    }
  }
  health() {
    return this.call<{ status: string }>("/health", {}, 3_000);
  }
  accounts() {
    return this.call<CreatorHubAccount[]>(
      "/api/accounts?platform=douyin",
      {},
      10_000,
    );
  }
  loginStart() {
    return this.call<{ task_id: string }>(
      "/api/login/browser/start?proxy=auto",
      {
        method: "POST",
        body: "{}",
      },
    );
  }
  loginPoll(taskId: string) {
    return this.call<{ status: string; error?: string }>(
      `/api/login/browser/poll?task_id=${encodeURIComponent(taskId)}`,
    );
  }
  resolve(url: string) {
    return this.call<{ aweme_id: string; title: string }>(
      "/api/comment-watches/resolve",
      { method: "POST", body: JSON.stringify({ url_or_id: url }) },
    );
  }
  watches() {
    return this.call<CreatorHubWatch[]>("/api/comment-watches?platform=douyin");
  }
  createWatch(input: {
    platform: "douyin";
    kind: "video";
    url_or_id: string;
    account_id: number;
    interval_seconds: number;
    group_name: string;
  }) {
    return this.call<CreatorHubWatch>("/api/comment-watches", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
  disableWatch(id: number) {
    return this.call<CreatorHubWatch>(`/api/comment-watches/${id}`, {
      method: "PUT",
      body: JSON.stringify({ enabled: false }),
    });
  }
  scan(id: number) {
    return this.call<Record<string, unknown>>(
      `/api/comment-watches/${id}/scan-now`,
      { method: "POST", body: "{}" },
      180_000,
    );
  }
  async comments(watchId: number) {
    const all: CreatorHubComment[] = [];
    for (let page = 1; page <= 20; page++) {
      const result = await this.call<{
        items?: CreatorHubComment[];
        has_next: boolean;
      }>(
        `/api/comments?platform=douyin&watch_id=${watchId}&paginate=true&page=${page}&page_size=200`,
      );
      const items = result.items ?? [];
      all.push(...items);
      if (!result.has_next || items.length === 0) break;
    }
    return all;
  }
  sendDm(input: {
    accountId: number;
    targetSecUid: string;
    targetNick: string;
    content: string;
    idempotencyKey: string;
  }) {
    return this.call<{ id: number; status: string }>(
      "/api/account-actions",
      {
        method: "POST",
        headers: { "Idempotency-Key": input.idempotencyKey },
        body: JSON.stringify({
          account_id: input.accountId,
          action: "send_dm",
          target_sec_uid: input.targetSecUid,
          target_nick: input.targetNick,
          content: input.content,
          run_now: false,
        }),
      },
      60_000,
    );
  }
  actions(accountId: number) {
    return this.call<CreatorHubAction[]>(
      `/api/account-actions?account_id=${accountId}&limit=100`,
    );
  }
  cancelAction(id: number) {
    return this.call<{ ok: boolean }>(`/api/account-actions/${id}/cancel`, {
      method: "POST",
      body: "{}",
    });
  }
}
