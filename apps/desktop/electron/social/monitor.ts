import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  CreatorHubStartInput,
  CommentSyncResult,
  WorkMonitorSummary,
} from "@keagent/shared-types";
import type { DouyinBrowser } from "../publishing/browser";
import { PublishingError, type PublishingIdentity } from "../publishing/core";
import { samePublisher } from "../publishing/queue";
import { atomicJSON } from "../publishing/files";
import { collectWorkComments, resolveCommentTarget } from "./comments";

type Watch = WorkMonitorSummary & { url: string };
const interval = 15 * 60_000;

export class WorkMonitor {
  private active?: { id: string; controller: AbortController };
  constructor(
    private browser: Pick<DouyinBrowser, "observeSocial" | "socialAccounts">,
    private identity: () => Promise<PublishingIdentity>,
    private request: (route: string, body?: unknown) => Promise<unknown>,
    private directory: (identity: PublishingIdentity) => string,
  ) {}
  private file(identity: PublishingIdentity) {
    return path.join(this.directory(identity), "work-monitors.json");
  }
  private watches(identity: PublishingIdentity): Watch[] {
    try {
      const rows = JSON.parse(fs.readFileSync(this.file(identity), "utf8"));
      if (!Array.isArray(rows)) throw new Error();
      return rows;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new PublishingError("MONITOR_STORAGE", "无法读取作品监控记录");
    }
  }
  history(identity: PublishingIdentity) {
    return this.watches(identity).map(({ url: _url, ...row }) => ({
      ...row,
      mode: row.mode ?? "monitor",
    }));
  }
  list(identity: PublishingIdentity) {
    return this.history(identity).filter((row) => row.mode === "monitor");
  }
  async status(identity: PublishingIdentity) {
    const accounts = (await this.browser.socialAccounts(identity)).filter(
      (a) => a.loginStatus === "logged_in",
    );
    return {
      health: "ready",
      selectedAccountId: "",
      accounts: accounts.map((a) => ({
        id: a.id,
        nickname: a.name,
        platform: a.platform ?? "douyin",
        status: "active",
        has_read_login: true,
      })),
      progress: this.active ? "正在读取作品评论" : "",
    };
  }
  private async current(identity: PublishingIdentity, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!samePublisher(identity, await this.identity()))
      throw new PublishingError("SESSION_CHANGED", "登录账号已切换");
    signal.throwIfAborted();
  }
  private save(identity: PublishingIdentity, watch: Watch) {
    const rows = this.watches(identity);
    atomicJSON(this.file(identity), [
      ...rows.filter((r) => r.id !== watch.id),
      watch,
    ]);
  }
  remove(identity: PublishingIdentity, id: string) {
    const watch = this.watches(identity).find((row) => row.id === id);
    if (!watch || (watch.mode ?? "monitor") !== "monitor")
      throw new PublishingError("MONITOR_MISSING", "监控不存在");
    if (this.active?.id === id) this.active.controller.abort();
    this.save(identity, { ...watch, mode: "stopped", nextScan: 0, error: "" });
  }
  async start(identity: PublishingIdentity, input: CreatorHubStartInput) {
    if (
      input.consent?.accepted !== true ||
      !/^[a-zA-Z0-9_-]{8,100}$/.test(input.requestKey)
    )
      throw new PublishingError("CONSENT_REQUIRED", "请确认作品评论的来源授权");
    const account = (await this.browser.socialAccounts(identity)).find(
      (a) => a.id === input.accountId && a.loginStatus === "logged_in",
    );
    if (!account)
      throw new PublishingError(
        "ACCOUNT_UNAVAILABLE",
        "请先登录并保存所选平台账号",
      );
    const platform = account.platform ?? "douyin";
    const target = await resolveCommentTarget(
      platform,
      input.url,
      AbortSignal.timeout(15_000),
    );
    const workId = platform === "xhs" ? "xhs-" + target.workId : target.workId;
    const existing = this.watches(identity).find(
      (w) => w.workId === workId && w.accountId === account.id,
    );
    const watch: Watch = {
      id: existing?.id ?? randomUUID(),
      accountId: account.id,
      platform,
      mode:
        input.monitor ||
        (existing && (existing.mode ?? "monitor") === "monitor")
          ? "monitor"
          : "once",
      workId,
      url: target.url,
      lastScan: existing?.lastScan,
      readCount: existing?.readCount ?? 0,
      addedCount: existing?.addedCount ?? 0,
      error: "",
      nextScan: Date.now() + interval,
    };
    return this.read(
      identity,
      watch,
      input.requestKey,
      watch.mode === "monitor",
      input.consent,
    );
  }
  async scan(identity: PublishingIdentity, id: string) {
    const watch = this.watches(identity).find((w) => w.id === id);
    if (!watch) throw new PublishingError("MONITOR_MISSING", "作品监控已移除");
    return this.read(
      identity,
      watch,
      randomUUID(),
      (watch.mode ?? "monitor") === "monitor",
    );
  }
  private async read(
    identity: PublishingIdentity,
    watch: Watch,
    key: string,
    monitor: boolean,
    consent?: CreatorHubStartInput["consent"],
  ) {
    if (this.active)
      throw new PublishingError("MONITOR_BUSY", "已有作品正在读取，请稍后再试");
    const controller = new AbortController();
    this.active = { id: watch.id, controller };
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(120_000),
    ]);
    const scope = { accountId: watch.accountId, workId: watch.workId };
    let saved = false;
    try {
      await this.current(identity, signal);
      if (consent)
        await this.request("/v1/collection/lead/consent/save", {
          ...scope,
          label: watch.platform === "xhs" ? "小红书作品评论" : "抖音作品评论",
          retentionDays: consent.retentionDays ?? 7,
          expiresAt:
            consent.expiresAt ??
            new Date(Date.now() + 30 * 86400000).toISOString(),
        });
      else {
        const grant = (await this.request(
          "/v1/collection/lead/consent/get",
          scope,
        )) as { state: string };
        if (grant.state !== "active")
          throw new PublishingError(
            "CONSENT_REQUIRED",
            "来源授权已失效，请重新授权",
          );
      }
      await this.current(identity, signal);
      if (monitor) {
        this.save(identity, watch);
        saved = true;
      }
      const snapshot = await this.browser.observeSocial(
        identity,
        watch.accountId,
        watch.platform,
        signal,
        (page) => collectWorkComments(page, watch.platform, watch.url, signal),
      );
      await this.current(identity, signal);
      if (
        (watch.platform === "xhs"
          ? "xhs-" + snapshot.workId
          : snapshot.workId) !== watch.workId
      )
        throw new PublishingError("WORK_CHANGED", "平台返回了其他作品");
      const result = (await this.request("/v1/collection/comments/import", {
        ...scope,
        requestKey: key,
        snapshotId: randomUUID().replaceAll("-", ""),
        observedAt: snapshot.observedAt,
        coverage: snapshot.coverage,
        items: snapshot.items.slice(0, 500),
      })) as CommentSyncResult;
      await this.current(identity, signal);
      this.save(identity, {
        ...watch,
        lastScan: snapshot.observedAt,
        nextScan: monitor ? Date.now() + interval : 0,
        readCount: result.readCount,
        addedCount: result.addedCount,
        error: "",
      });
      return { ...result, awemeId: watch.workId, accountId: watch.accountId };
    } catch (error) {
      if (
        monitor &&
        !controller.signal.aborted &&
        (saved || !consent) &&
        this.watches(identity).some((w) => w.id === watch.id)
      ) {
        this.save(identity, {
          ...watch,
          error:
            error instanceof PublishingError
              ? error.message
              : "读取未完成，请检查平台账号或服务连接",
          nextScan: Date.now() + interval,
        });
      }
      throw error;
    } finally {
      this.active = undefined;
    }
  }
  async tick() {
    if (this.active) return;
    const identity = await this.identity();
    const due = this.watches(identity)
      .filter(
        (w) => (w.mode ?? "monitor") === "monitor" && w.nextScan <= Date.now(),
      )
      .sort((a, b) => a.nextScan - b.nextScan)[0];
    if (due) await this.scan(identity, due.id);
  }
  stop() {
    this.active?.controller.abort();
  }
}
