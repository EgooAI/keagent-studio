import { createHash, randomBytes } from "node:crypto";
import { PublishingError } from "../publishing/core";
import { CreatorHubClient } from "./client";
import { normalizeComments } from "./normalize";

export interface BridgeDependencies {
  request(route: string, input?: unknown): Promise<unknown>;
  client(baseUrl: string): CreatorHubClient;
}

function linkedAccountId(creatorHubAccountId: string | number) {
  return createHash("sha256")
    .update(`creatorhub:${String(creatorHubAccountId)}`)
    .digest("hex")
    .slice(0, 32);
}

export class CreatorHubBridge {
  progress = "";
  constructor(private deps: BridgeDependencies) {}

  private async settings() {
    return (await this.deps.request(
      "/v1/collection/lead/settings/get",
      {},
    )) as {
      creatorhubBaseUrl: string;
      creatorhubAccountId: string;
    };
  }

  async status() {
    const settings = await this.settings();
    const client = this.deps.client(settings.creatorhubBaseUrl);
    try {
      await client.health();
      const accounts = (await client.accounts())
        .filter(
          (account) =>
            account.platform === "douyin" &&
            account.status === "active" &&
            account.has_read_login,
        )
        .map((account) => ({
          id: String(account.id),
          nickname: account.nickname,
          status: account.status,
          has_read_login: account.has_read_login,
        }));
      return {
        health: "ready",
        accounts,
        selectedAccountId: settings.creatorhubAccountId,
        progress: this.progress,
      };
    } catch {
      return {
        health: "offline",
        accounts: [],
        selectedAccountId: "",
        progress: this.progress,
      };
    }
  }

  async login() {
    const settings = await this.settings();
    const client = this.deps.client(settings.creatorhubBaseUrl);
    const started = await client.loginStart();
    for (let i = 0; i < 180; i++) {
      const state = await client.loginPoll(started.task_id);
      if (state.status === "confirmed") return this.status();
      if (state.status === "error" || state.status === "expired")
        throw new PublishingError(
          "CREATORHUB_LOGIN_FAILED",
          state.error || "抖音登录未完成，请重试",
        );
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new PublishingError(
      "CREATORHUB_LOGIN_TIMEOUT",
      "登录等待超时，请重新扫码",
    );
  }

  async start(input: {
    url: string;
    accountId: string;
    requestKey: string;
    consent: { accepted: boolean; retentionDays?: number; expiresAt?: string };
  }) {
    if (!input.consent?.accepted)
      throw new PublishingError(
        "CONSENT_REQUIRED",
        "请先确认评论来源授权",
        422,
      );
    const settings = await this.settings();
    const client = this.deps.client(settings.creatorhubBaseUrl);
    this.progress = "检查 CreatorHub";
    await client.health();
    const account = (await client.accounts()).find(
      (item) => String(item.id) === input.accountId,
    );
    if (!account || account.status !== "active" || !account.has_read_login)
      throw new PublishingError(
        "CREATORHUB_ACCOUNT_UNAVAILABLE",
        "请选择一个已登录的 CreatorHub 抖音账号",
      );

    const linked = linkedAccountId(account.id);
    await this.deps.request("/v1/douyin/accounts/bind", {
      id: linked,
      name: account.nickname || "CreatorHub 账号",
      loginStatus: "logged_in",
    });

    this.progress = "解析视频";
    const resolved = await client.resolve(input.url);
    const workId = resolved.aweme_id;

    this.progress = "准备评论监控";
    const watches = await client.watches();
    let watch = watches.find(
      (item) =>
        item.aweme_id === workId && item.account_id === Number(account.id),
    );
    if (!watch) {
      watch = await client.createWatch({
        platform: "douyin",
        kind: "video",
        url_or_id: input.url,
        account_id: Number(account.id),
        interval_seconds: 86400,
        group_name: "creatorhub",
      });
      await client.disableWatch(watch.id);
    }

    this.progress = "抓取评论";
    await client.scan(watch.id);
    const rows = await client.comments(watch.id);
    const items = normalizeComments(rows).slice(0, 500);
    if (items.length === 0)
      throw new PublishingError(
        "CREATORHUB_NO_COMMENTS",
        "该视频没有可读取的一级评论",
      );

    this.progress = "保存来源授权";
    const retentionDays = input.consent.retentionDays ?? 7;
    const expiresAt =
      input.consent.expiresAt ??
      new Date(Date.now() + 30 * 86400000).toISOString();
    await this.deps.request("/v1/collection/creatorhub/consent/save", {
      accountId: linked,
      workId,
      label: "CreatorHub 来源",
      retentionDays,
      expiresAt,
      baseUrl: settings.creatorhubBaseUrl,
      creatorhubAccountId: String(account.id),
    });

    this.progress = "导入评论";
    const imported = (await this.deps.request(
      "/v1/collection/comments/import",
      {
        accountId: linked,
        workId,
        requestKey: input.requestKey,
        snapshotId: randomBytes(16).toString("hex"),
        observedAt: new Date().toISOString(),
        coverage: "partial",
        items,
      },
    )) as { readCount: number; addedCount: number; updatedCount: number };
    this.progress = "";
    return {
      watchId: watch.id,
      awemeId: workId,
      accountId: linked,
      ...imported,
      coverage: "partial",
    };
  }
}
