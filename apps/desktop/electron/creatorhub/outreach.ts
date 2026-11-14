import { PublishingError } from "../publishing/core";
import type { BridgeDependencies } from "./bridge";

const RETRYABLE = new Set([
  "CREATORHUB_TIMEOUT",
  "CREATORHUB_INVALID_RESPONSE",
  "CREATORHUB_UNAVAILABLE",
]);
const REJECTED_WITHOUT_EFFECT = new Set([400, 403, 404, 422]);

function codeOf(error: unknown) {
  return (error as { code?: string }).code ?? "";
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function truncateRunes(value: string, limit = 500) {
  const runes = Array.from(value);
  return runes.length > limit ? runes.slice(0, limit).join("") : value;
}

function uncertainError(id: string, attempt: number, message: string) {
  return new PublishingError(
    "OUTREACH_UNCERTAIN",
    `私信发送结果不确定，请刷新后确认（任务 ${id}，第 ${attempt} 次尝试）：${truncateRunes(message)}`,
    409,
  );
}

export class CreatorHubOutreach {
  constructor(private deps: Pick<BridgeDependencies, "request" | "client">) {}

  private async settings() {
    return (await this.deps.request(
      "/v1/collection/lead/settings/get",
      {},
    )) as {
      creatorhubBaseUrl: string;
      creatorhubAccountId: string;
    };
  }

  private async recordFailure(id: string, attempt: number, message: string) {
    await this.deps.request("/v1/collection/outreach/result", {
      id,
      attempt,
      status: "failed",
      error: truncateRunes(message),
    });
  }

  private async recordUncertain(id: string, attempt: number, message: string) {
    await this.deps.request("/v1/collection/outreach/result", {
      id,
      attempt,
      status: "uncertain",
      error: truncateRunes(message),
    });
  }

  async submit(input: {
    analysisId: string;
    draft: string;
    requestKey: string;
  }) {
    const created = (await this.deps.request("/v1/collection/outreach/submit", {
      analysisId: input.analysisId,
      draft: input.draft,
      requestKey: input.requestKey,
    })) as {
      id: string;
      status: string;
      commenterProfile: string;
      commenterName: string;
      attempt: number;
    };
    if (created.status !== "approved") {
      const row = await this.load(created.id);
      return { ...row, analysisId: input.analysisId };
    }
    let client: ReturnType<BridgeDependencies["client"]>;
    let creatorHubAccountId: string;
    let targetSecUid: string;
    try {
      const row = await this.load(created.id);
      const consent = (await this.deps.request(
        "/v1/collection/creatorhub/consent/get",
        { accountId: row.accountId, workId: row.workId },
      )) as { creatorhubAccountId?: unknown };
      creatorHubAccountId = String(consent?.creatorhubAccountId ?? "");
      if (!/^[0-9]{1,20}$/.test(creatorHubAccountId))
        throw new PublishingError(
          "CREATORHUB_ACCOUNT_UNAVAILABLE",
          "该作品缺少 CreatorHub 账号授权，请重新抓取评论",
        );
      targetSecUid = created.commenterProfile?.split("/").pop() || "";
      if (!/^[A-Za-z0-9_-]+$/.test(targetSecUid))
        throw new PublishingError(
          "COMMENT_PROFILE_UNAVAILABLE",
          "缺少评论者主页，无法私信",
        );

      const settings = await this.settings();
      client = this.deps.client(settings.creatorhubBaseUrl);
    } catch (error) {
      // No CreatorHub side effect has happened yet: mark the attempt failed so
      // a fresh submission can reset the row instead of hitting OUTREACH_EXISTS.
      await this.recordFailure(
        created.id,
        created.attempt,
        messageOf(error),
      ).catch(() => {});
      throw error;
    }
    const idempotencyKey = `ch-${created.id}-${created.attempt}`;
    let task: { id: number; status: string } | undefined;
    for (let attempt = 0; attempt < 2 && !task; attempt++) {
      try {
        const sent = await client.sendDm({
          accountId: Number(creatorHubAccountId),
          targetSecUid,
          targetNick: created.commenterName || "",
          content: input.draft,
          idempotencyKey,
        });
        if (!sent)
          throw new PublishingError(
            "CREATORHUB_INVALID_RESPONSE",
            "CreatorHub 未返回任务回执",
            502,
          );
        task = sent;
      } catch (error) {
        const code = codeOf(error);
        if (code === "CREATORHUB_REJECTED") {
          const status = (error as { status?: number }).status;
          if (status && REJECTED_WITHOUT_EFFECT.has(status)) {
            // The request was definitively rejected before any remote effect.
            await this.recordFailure(
              created.id,
              created.attempt,
              messageOf(error),
            );
            throw error;
          }
          // 409/410, 5xx, and unclassified rejections may have been processed.
          const message = messageOf(error);
          await this.recordUncertain(created.id, created.attempt, message);
          throw uncertainError(created.id, created.attempt, message);
        }
        if (code === "CREATORHUB_URL_INVALID") {
          // The client rejects the URL before any request leaves the process.
          await this.recordFailure(
            created.id,
            created.attempt,
            messageOf(error),
          );
          throw error;
        }
        if (!RETRYABLE.has(code)) throw error;
        if (attempt === 0) continue;
        const message = messageOf(error);
        await this.recordUncertain(created.id, created.attempt, message);
        throw uncertainError(created.id, created.attempt, message);
      }
    }
    if (!task)
      throw uncertainError(
        created.id,
        created.attempt,
        "CreatorHub 未返回任务回执",
      );
    await this.deps.request("/v1/collection/outreach/result", {
      id: created.id,
      attempt: created.attempt,
      status: "submitted",
      creatorhubTaskId: String(task.id),
      method: "browser",
    });
    return {
      id: created.id,
      analysisId: input.analysisId,
      attempt: created.attempt,
      status: "submitted",
      creatorhubTaskId: String(task.id),
      error: "",
      draft: input.draft,
      requestKey: input.requestKey,
    };
  }

  private async load(outreachId: string) {
    const result = (await this.deps.request("/v1/collection/outreach/list", {
      id: outreachId,
      limit: 1,
    })) as {
      items: Array<{
        id: string;
        analysisId: string;
        status: string;
        attempt: number;
        creatorhubTaskId: string;
        accountId: string;
        workId: string;
        draft: string;
        error: string;
        requestKey: string;
      }>;
    };
    const row = result.items[0];
    if (!row)
      throw new PublishingError("OUTREACH_NOT_FOUND", "私信任务不存在", 404);
    return {
      id: row.id,
      analysisId: row.analysisId,
      status: row.status,
      attempt: row.attempt,
      creatorhubTaskId: row.creatorhubTaskId,
      accountId: row.accountId,
      workId: row.workId,
      draft: row.draft,
      error: row.error,
      requestKey: row.requestKey,
    };
  }

  async refresh(input: { outreachId: string; attempt: number }) {
    const row = await this.load(input.outreachId);
    if (row.attempt !== input.attempt) return row;
    if (
      !row.creatorhubTaskId ||
      ["sent", "uncertain", "failed", "canceled"].includes(row.status)
    )
      return row;
    const consent = (await this.deps.request(
      "/v1/collection/creatorhub/consent/get",
      { accountId: row.accountId, workId: row.workId },
    )) as { creatorhubAccountId: string };
    const settings = await this.settings();
    const client = this.deps.client(settings.creatorhubBaseUrl);
    const tasks = await client.actions(Number(consent.creatorhubAccountId));
    const task = tasks.find((item) => String(item.id) === row.creatorhubTaskId);
    if (!task) return row;
    const status =
      task.status === "done"
        ? "sent"
        : task.status === "doing"
          ? "sending"
          : task.status === "failed"
            ? "failed"
            : task.status === "uncertain"
              ? "uncertain"
              : task.status === "canceled"
                ? "canceled"
                : "submitted";
    await this.deps.request("/v1/collection/outreach/result", {
      id: row.id,
      attempt: row.attempt,
      status,
      creatorhubTaskId: row.creatorhubTaskId,
      error: truncateRunes(task.error || ""),
    });
    return { ...row, status };
  }

  async cancel(input: { outreachId: string; attempt: number }) {
    const row = await this.load(input.outreachId);
    if (row.attempt !== input.attempt)
      throw new PublishingError(
        "OUTREACH_CHANGED",
        "任务已重试，请刷新后重新操作",
        409,
      );
    if (!row.creatorhubTaskId)
      throw new PublishingError(
        "OUTREACH_NOT_SUBMITTED",
        "任务尚未进入 CreatorHub 队列",
      );
    const settings = await this.settings();
    const client = this.deps.client(settings.creatorhubBaseUrl);
    await client.cancelAction(Number(row.creatorhubTaskId));
    await this.deps.request("/v1/collection/outreach/result", {
      id: row.id,
      attempt: input.attempt,
      status: "canceled",
      creatorhubTaskId: row.creatorhubTaskId,
    });
    return { ...row, status: "canceled" };
  }

  async confirm(input: {
    outreachId: string;
    attempt: number;
    status: "sent" | "failed";
  }) {
    if (input.status !== "sent" && input.status !== "failed")
      throw new PublishingError("INVALID_INPUT", "确认状态无效", 422);
    const row = await this.load(input.outreachId);
    if (row.attempt !== input.attempt)
      throw new PublishingError(
        "OUTREACH_CHANGED",
        "任务已重试，请刷新后重新确认",
        409,
      );
    if (row.status !== "uncertain")
      throw new PublishingError(
        "OUTREACH_NOT_UNCERTAIN",
        "该任务无需人工确认",
        409,
      );
    await this.deps.request("/v1/collection/outreach/result", {
      id: row.id,
      attempt: input.attempt,
      status: input.status,
      confirmed: true,
    });
    return { ...row, status: input.status };
  }
}
