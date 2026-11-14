import { createHash, randomBytes } from "node:crypto";
import { PublishingError } from "../publishing/core";
import { CreatorHubClient } from "./client";
import type { CreatorHubWatch } from "./client";
import { normalizeComments } from "./normalize";

export interface BridgeDependencies {
  request(route: string, input?: unknown): Promise<unknown>;
  client(baseUrl: string): CreatorHubClient;
  identity?(): Promise<{ userId: string; deviceId: string }>;
}

function linkedAccountId(
  userId: string,
  deviceId: string,
  creatorHubAccountId: string | number,
  generation = 1,
) {
  const scope = `creatorhub:${userId}:${deviceId}:${String(creatorHubAccountId)}`;
  return createHash("sha256")
    .update(generation === 1 ? scope : `${scope}:${generation}`)
    .digest("hex")
    .slice(0, 32);
}

function findWatch(
  watches: CreatorHubWatch[],
  awemeId: string,
  accountId: number,
) {
  const matching = watches.filter((item) => item.aweme_id === awemeId);
  return matching.find((item) => item.account_id === accountId) ?? matching[0];
}

export class CreatorHubBridge {
  progress = "";
  private running = false;
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
    try {
      const client = this.deps.client(settings.creatorhubBaseUrl);
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
        selectedAccountId: settings.creatorhubAccountId,
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
    if (this.running)
      throw new PublishingError(
        "CREATORHUB_BUSY",
        "已有评论抓取正在进行，请稍后重试",
        409,
      );
    this.running = true;
    let warning: string | undefined;
    try {
      const identity = await this.deps.identity?.();
      if (!identity?.userId?.trim() || !identity?.deviceId?.trim())
        throw new PublishingError(
          "IDENTITY_UNAVAILABLE",
          "缺少用户或设备身份",
          409,
        );
      const { userId, deviceId } = identity;

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

      let linked = "";
      let bindError: unknown;
      for (let generation = 1; generation <= 8; generation++) {
        const candidate = linkedAccountId(
          userId,
          deviceId,
          account.id,
          generation,
        );
        try {
          await this.deps.request("/v1/douyin/accounts/bind", {
            id: candidate,
            name: account.nickname || "CreatorHub 账号",
            loginStatus: "logged_in",
            platformUserId: account.sec_uid || account.douyin_id || "",
          });
          linked = candidate;
          break;
        } catch (error) {
          if ((error as { code?: string }).code !== "ACCOUNT_UNAVAILABLE")
            throw error;
          bindError = error;
        }
      }
      if (!linked) throw bindError;

      this.progress = "解析视频";
      const resolved = await client.resolve(input.url);
      const workId = resolved.aweme_id;

      this.progress = "准备评论监控";
      const accountNumber = Number(account.id);
      let watch = findWatch(await client.watches(), workId, accountNumber);
      let createdByBridge = false;
      if (!watch) {
        try {
          watch = await client.createWatch({
            platform: "douyin",
            kind: "video",
            url_or_id: workId,
            account_id: accountNumber,
            interval_seconds: 86400,
            group_name: "creatorhub",
          });
          createdByBridge = true;
        } catch (error) {
          if (!(error instanceof PublishingError) || error.status !== 409)
            throw error;
          watch = findWatch(await client.watches(), workId, accountNumber);
          if (!watch) throw error;
        }
      }
      if (
        createdByBridge ||
        (watch.group_name === "creatorhub" && watch.enabled)
      )
        await client.disableWatch(watch.id);

      this.progress = "抓取评论";
      try {
        const scan = (await client.scan(watch.id)) as {
          ok?: boolean;
          skipped?: boolean | string;
          reason?: string;
          error?: string;
        };
        if (scan?.skipped)
          throw new PublishingError(
            "CREATORHUB_SCAN_SKIPPED",
            scan.reason ||
              (typeof scan.skipped === "string"
                ? scan.skipped
                : "当前无法抓取评论，请稍后重试"),
            409,
          );
        if (scan?.ok !== true)
          throw new PublishingError(
            "CREATORHUB_SCAN_FAILED",
            scan?.error || "评论抓取失败，请稍后重试",
            502,
          );
      } catch (error) {
        if (
          error instanceof PublishingError &&
          error.code === "CREATORHUB_TIMEOUT"
        ) {
          warning = "抓取超时，已导入现有评论";
        } else {
          throw error;
        }
      }

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

      return {
        watchId: watch.id,
        awemeId: workId,
        accountId: linked,
        ...imported,
        coverage: "partial",
        warning,
      };
    } finally {
      this.progress = "";
      this.running = false;
    }
  }
}
