import { PublishingError } from "../publishing/core";
import type { BridgeDependencies } from "./bridge";

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

  async submit(input: {
    analysisId: string;
    draft: string;
    requestKey: string;
    creatorHubAccountId: string;
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
    const settings = await this.settings();
    const client = this.deps.client(settings.creatorhubBaseUrl);
    if (!created.commenterProfile)
      throw new PublishingError(
        "COMMENT_PROFILE_UNAVAILABLE",
        "缺少评论者主页，无法私信",
      );
    const targetSecUid = created.commenterProfile.split("/").pop()!;
    let task: { id: number; status: string } | undefined;
    for (let attempt = 0; attempt < 2 && !task; attempt++) {
      try {
        task = await client.sendDm({
          accountId: Number(input.creatorHubAccountId),
          targetSecUid,
          targetNick: created.commenterName || "",
          content: input.draft,
          idempotencyKey: `ch-${created.id}-${created.attempt}`,
        });
      } catch (error) {
        if ((error as { code?: string }).code === "CREATORHUB_REJECTED")
          throw error;
      }
    }
    if (!task) {
      await this.deps.request("/v1/collection/outreach/result", {
        id: created.id,
        attempt: created.attempt,
        status: "uncertain",
        error: "CreatorHub 未返回任务回执，请核对发送记录",
      });
      return {
        id: created.id,
        analysisId: input.analysisId,
        attempt: created.attempt,
        status: "uncertain",
        creatorhubTaskId: "",
        error: "",
      };
    }
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
    };
  }

  private async load(outreachId: string) {
    const result = (await this.deps.request("/v1/collection/outreach/list", {
      id: outreachId,
      limit: 1,
    })) as {
      items: Array<{
        id: string;
        status: string;
        attempt: number;
        creatorhubTaskId: string;
        accountId: string;
        workId: string;
      }>;
    };
    const row = result.items[0];
    if (!row)
      throw new PublishingError("OUTREACH_NOT_FOUND", "私信任务不存在", 404);
    return row;
  }

  async refresh(input: { outreachId: string }) {
    const row = await this.load(input.outreachId);
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
      error: task.error || "",
    });
    return { ...row, status };
  }

  async cancel(input: { outreachId: string }) {
    const row = await this.load(input.outreachId);
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
      attempt: row.attempt,
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
    const row = await this.load(input.outreachId);
    if (row.attempt !== input.attempt)
      throw new PublishingError(
        "OUTREACH_CHANGED",
        "任务已重试，请刷新后重新确认",
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
