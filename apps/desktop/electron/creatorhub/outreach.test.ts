import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { PublishingError } from "../publishing/core";
import { CreatorHubClient } from "./client";
import { CreatorHubOutreach } from "./outreach";

type Server = ReturnType<typeof createServer>;

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          (
            server as Server & { closeAllConnections?: () => void }
          ).closeAllConnections?.();
          server.close(() => resolve());
        }),
    ),
  );
});

async function start(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return { server, base: `http://127.0.0.1:${address.port}` };
}

async function readJson(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

interface Call {
  route: string;
  input: any;
}

interface Row {
  id: string;
  status: string;
  attempt: number;
  creatorhubTaskId: string;
  accountId: string;
  workId: string;
}

const outreachId = "o".repeat(32);
const analysisId = "a".repeat(32);
const requestKey = "r".repeat(32);
const baseRow: Row = {
  id: outreachId,
  status: "approved",
  attempt: 1,
  creatorhubTaskId: "",
  accountId: "account-1",
  workId: "1234567890",
};
const approved = {
  id: outreachId,
  attempt: 1,
  status: "approved",
  commenterProfile: "https://www.douyin.com/user/sec1",
  commenterName: "甲",
};

function scripted(options: {
  calls?: Call[];
  submit?: unknown;
  rows?: Row[];
  consent?: unknown;
  base?: string;
}) {
  return async (route: string, input?: unknown) => {
    options.calls?.push({ route, input });
    if (route.endsWith("outreach/submit")) return options.submit;
    if (route.endsWith("outreach/list"))
      return { items: options.rows ?? [baseRow] };
    if (route.endsWith("creatorhub/consent/get"))
      return options.consent ?? { creatorhubAccountId: "7" };
    if (route.endsWith("lead/settings/get"))
      return {
        creatorhubBaseUrl: options.base ?? "http://127.0.0.1:1",
        creatorhubAccountId: "1",
      };
    return {};
  };
}

function fakeClient(overrides: Partial<CreatorHubClient>) {
  return overrides as unknown as CreatorHubClient;
}

async function rejection(promise: Promise<unknown>): Promise<PublishingError> {
  try {
    await promise;
  } catch (error) {
    return error as PublishingError;
  }
  throw new Error("expected the outreach call to reject");
}

describe("CreatorHubOutreach submit", () => {
  it("submits with the consent-derived account and records the task", async () => {
    let key = "";
    let payload: any = {};
    const { base } = await start(async (req, res) => {
      key = String(req.headers["idempotency-key"] || "");
      payload = await readJson(req);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: 9, status: "pending" }));
    });
    const calls: Call[] = [];
    const outreach = new CreatorHubOutreach({
      request: scripted({ calls, submit: approved, base }),
      client: (baseUrl) => new CreatorHubClient(baseUrl),
    });
    const result = await outreach.submit({
      analysisId,
      draft: "您好",
      requestKey,
    });
    expect(result.status).toBe("submitted");
    expect(key).toBe(`ch-${outreachId}-1`);
    expect(payload).toMatchObject({
      account_id: 7,
      action: "send_dm",
      target_sec_uid: "sec1",
      target_nick: "甲",
      content: "您好",
      run_now: false,
    });
    expect(
      calls.find((call) => call.route.endsWith("outreach/submit"))?.input,
    ).toEqual({ analysisId, draft: "您好", requestKey });
    expect(
      calls.find((call) => call.route.endsWith("creatorhub/consent/get"))
        ?.input,
    ).toEqual({ accountId: baseRow.accountId, workId: baseRow.workId });
    const resultCall = calls.find((call) =>
      call.route.endsWith("outreach/result"),
    );
    expect(resultCall?.input).toMatchObject({
      id: outreachId,
      attempt: 1,
      status: "submitted",
      creatorhubTaskId: "9",
      method: "browser",
    });
  });

  it("retries a timeout once with the same key and records a single submitted result", async () => {
    const keys: string[] = [];
    let sends = 0;
    const calls: Call[] = [];
    const outreach = new CreatorHubOutreach({
      request: scripted({ calls, submit: approved }),
      client: () =>
        fakeClient({
          sendDm: async (input) => {
            keys.push(input.idempotencyKey);
            sends++;
            if (sends === 1)
              throw new PublishingError("CREATORHUB_TIMEOUT", "超时", 503);
            return { id: 12, status: "pending" };
          },
        }),
    });
    const result = await outreach.submit({
      analysisId,
      draft: "您好",
      requestKey,
    });
    expect(result.status).toBe("submitted");
    expect(keys).toEqual([`ch-${outreachId}-1`, `ch-${outreachId}-1`]);
    const writes = calls.filter((call) =>
      call.route.endsWith("outreach/result"),
    );
    expect(writes).toHaveLength(1);
    expect(writes[0].input).toMatchObject({
      status: "submitted",
      creatorhubTaskId: "12",
    });
  });

  it("records one uncertain result when both attempts time out", async () => {
    let sends = 0;
    const calls: Call[] = [];
    const outreach = new CreatorHubOutreach({
      request: scripted({ calls, submit: approved }),
      client: () =>
        fakeClient({
          sendDm: async () => {
            sends++;
            throw new PublishingError("CREATORHUB_TIMEOUT", "超时", 503);
          },
        }),
    });
    const error = await rejection(
      outreach.submit({ analysisId, draft: "您好", requestKey }),
    );
    expect(error).toMatchObject({ code: "OUTREACH_UNCERTAIN", status: 409 });
    expect(sends).toBe(2);
    const writes = calls.filter((call) =>
      call.route.endsWith("outreach/result"),
    );
    expect(writes).toHaveLength(1);
    expect(writes[0].input).toMatchObject({
      id: outreachId,
      attempt: 1,
      status: "uncertain",
      error: "超时",
    });
    expect(writes.some((call) => call.input.status === "submitted")).toBe(
      false,
    );
  });

  it("records one uncertain result when both attempts return no receipt", async () => {
    let sends = 0;
    const calls: Call[] = [];
    const outreach = new CreatorHubOutreach({
      request: scripted({ calls, submit: approved }),
      client: () =>
        fakeClient({
          sendDm: async () => {
            sends++;
            return undefined as unknown as { id: number; status: string };
          },
        }),
    });
    const error = await rejection(
      outreach.submit({ analysisId, draft: "您好", requestKey }),
    );
    expect(error).toMatchObject({ code: "OUTREACH_UNCERTAIN", status: 409 });
    expect(sends).toBe(2);
    const writes = calls.filter((call) =>
      call.route.endsWith("outreach/result"),
    );
    expect(writes).toHaveLength(1);
    expect(writes[0].input).toMatchObject({
      id: outreachId,
      attempt: 1,
      status: "uncertain",
      error: "CreatorHub 未返回任务回执",
    });
  });

  it("records a failed result and propagates an explicit CreatorHub rejection", async () => {
    const calls: Call[] = [];
    const outreach = new CreatorHubOutreach({
      request: scripted({ calls, submit: approved }),
      client: () =>
        fakeClient({
          sendDm: async () => {
            throw new PublishingError(
              "CREATORHUB_REJECTED",
              "x".repeat(600),
              422,
            );
          },
        }),
    });
    const error = await rejection(
      outreach.submit({ analysisId, draft: "您好", requestKey }),
    );
    expect(error).toMatchObject({ code: "CREATORHUB_REJECTED", status: 422 });
    const writes = calls.filter((call) =>
      call.route.endsWith("outreach/result"),
    );
    expect(writes).toHaveLength(1);
    expect(writes[0].input).toMatchObject({
      id: outreachId,
      attempt: 1,
      status: "failed",
    });
    expect(Array.from(String(writes[0].input.error))).toHaveLength(500);
  });

  it.each([409, 410, 500, 503])(
    "records an uncertain result for a %s rejection that may have been processed",
    async (status) => {
      const calls: Call[] = [];
      const outreach = new CreatorHubOutreach({
        request: scripted({ calls, submit: approved }),
        client: () =>
          fakeClient({
            sendDm: async () => {
              throw new PublishingError(
                "CREATORHUB_REJECTED",
                "上游错误",
                status,
              );
            },
          }),
      });
      const error = await rejection(
        outreach.submit({ analysisId, draft: "您好", requestKey }),
      );
      expect(error).toMatchObject({ code: "OUTREACH_UNCERTAIN", status: 409 });
      const writes = calls.filter((call) =>
        call.route.endsWith("outreach/result"),
      );
      expect(writes).toHaveLength(1);
      expect(writes[0].input).toMatchObject({
        id: outreachId,
        attempt: 1,
        status: "uncertain",
        error: "上游错误",
      });
    },
  );

  it.each([400, 403, 404, 422])(
    "records a failed result for a %s rejection that was not processed",
    async (status) => {
      const calls: Call[] = [];
      const outreach = new CreatorHubOutreach({
        request: scripted({ calls, submit: approved }),
        client: () =>
          fakeClient({
            sendDm: async () => {
              throw new PublishingError("CREATORHUB_REJECTED", "拒绝", status);
            },
          }),
      });
      const error = await rejection(
        outreach.submit({ analysisId, draft: "您好", requestKey }),
      );
      expect(error).toMatchObject({ code: "CREATORHUB_REJECTED", status });
      const writes = calls.filter((call) =>
        call.route.endsWith("outreach/result"),
      );
      expect(writes).toHaveLength(1);
      expect(writes[0].input).toMatchObject({
        id: outreachId,
        attempt: 1,
        status: "failed",
        error: "拒绝",
      });
    },
  );

  it("retries an unavailable CreatorHub and records uncertain when it persists", async () => {
    let sends = 0;
    const calls: Call[] = [];
    const outreach = new CreatorHubOutreach({
      request: scripted({ calls, submit: approved }),
      client: () =>
        fakeClient({
          sendDm: async () => {
            sends++;
            throw new PublishingError(
              "CREATORHUB_UNAVAILABLE",
              "无法连接",
              503,
            );
          },
        }),
    });
    const error = await rejection(
      outreach.submit({ analysisId, draft: "您好", requestKey }),
    );
    expect(error).toMatchObject({ code: "OUTREACH_UNCERTAIN", status: 409 });
    expect(sends).toBe(2);
    const writes = calls.filter((call) =>
      call.route.endsWith("outreach/result"),
    );
    expect(writes).toHaveLength(1);
    expect(writes[0].input).toMatchObject({
      id: outreachId,
      attempt: 1,
      status: "uncertain",
      error: "无法连接",
    });
  });

  it("returns the current row without calling CreatorHub when the attempt is not approved", async () => {
    let sends = 0;
    const calls: Call[] = [];
    const outreach = new CreatorHubOutreach({
      request: scripted({
        calls,
        submit: {
          ...approved,
          attempt: 2,
          status: "uncertain",
          commenterProfile: "",
        },
        rows: [{ ...baseRow, attempt: 2, status: "uncertain" }],
      }),
      client: () =>
        fakeClient({
          sendDm: async () => {
            sends++;
            return { id: 1, status: "pending" };
          },
        }),
    });
    const result = await outreach.submit({
      analysisId,
      draft: "您好",
      requestKey,
    });
    expect(result).toMatchObject({
      id: outreachId,
      analysisId,
      attempt: 2,
      status: "uncertain",
    });
    expect(sends).toBe(0);
    expect(
      calls.some((call) => call.route.endsWith("creatorhub/consent/get")),
    ).toBe(false);
    expect(calls.some((call) => call.route.endsWith("outreach/result"))).toBe(
      false,
    );
  });

  it("records a failed result when pre-send account validation fails", async () => {
    let sends = 0;
    const calls: Call[] = [];
    const outreach = new CreatorHubOutreach({
      request: scripted({
        calls,
        submit: approved,
        consent: { creatorhubAccountId: "not-a-number" },
      }),
      client: () =>
        fakeClient({
          sendDm: async () => {
            sends++;
            return { id: 1, status: "pending" };
          },
        }),
    });
    const error = await rejection(
      outreach.submit({ analysisId, draft: "您好", requestKey }),
    );
    expect(error).toMatchObject({
      code: "CREATORHUB_ACCOUNT_UNAVAILABLE",
    });
    expect(sends).toBe(0);
    const write = calls.find((call) => call.route.endsWith("outreach/result"));
    expect(write?.input).toMatchObject({
      id: outreachId,
      attempt: 1,
      status: "failed",
    });
  });

  it("records a failed result when the settings lookup fails before sending", async () => {
    let sends = 0;
    const calls: Call[] = [];
    const outreach = new CreatorHubOutreach({
      request: async (route, input) => {
        calls.push({ route, input });
        if (route.endsWith("outreach/submit")) return approved;
        if (route.endsWith("outreach/list")) return { items: [baseRow] };
        if (route.endsWith("creatorhub/consent/get"))
          return { creatorhubAccountId: "7" };
        if (route.endsWith("lead/settings/get"))
          throw new Error("settings down");
        return {};
      },
      client: () =>
        fakeClient({
          sendDm: async () => {
            sends++;
            return { id: 1, status: "pending" };
          },
        }),
    });
    const error = await rejection(
      outreach.submit({ analysisId, draft: "您好", requestKey }),
    );
    expect(error).toMatchObject({ message: "settings down" });
    expect(sends).toBe(0);
    const write = calls.find((call) => call.route.endsWith("outreach/result"));
    expect(write?.input).toMatchObject({
      id: outreachId,
      attempt: 1,
      status: "failed",
      error: "settings down",
    });
  });

  it("preserves the pre-send error when the failure write also fails", async () => {
    const outreach = new CreatorHubOutreach({
      request: async (route) => {
        if (route.endsWith("outreach/submit")) return approved;
        if (route.endsWith("outreach/list")) return { items: [baseRow] };
        if (route.endsWith("creatorhub/consent/get"))
          throw new PublishingError("CONSENT_REQUIRED", "缺少授权", 422);
        if (route.endsWith("outreach/result")) throw new Error("write down");
        return {};
      },
      client: () => fakeClient({}),
    });
    const error = await rejection(
      outreach.submit({ analysisId, draft: "您好", requestKey }),
    );
    expect(error).toMatchObject({ code: "CONSENT_REQUIRED", status: 422 });
  });

  it("records a failed result when the commenter profile has no safe sec_uid", async () => {
    let sends = 0;
    const calls: Call[] = [];
    const outreach = new CreatorHubOutreach({
      request: scripted({
        calls,
        submit: {
          ...approved,
          commenterProfile: "https://www.douyin.com/user/bad id!",
        },
      }),
      client: () =>
        fakeClient({
          sendDm: async () => {
            sends++;
            return { id: 1, status: "pending" };
          },
        }),
    });
    const error = await rejection(
      outreach.submit({ analysisId, draft: "您好", requestKey }),
    );
    expect(error).toMatchObject({ code: "COMMENT_PROFILE_UNAVAILABLE" });
    expect(sends).toBe(0);
    const write = calls.find((call) => call.route.endsWith("outreach/result"));
    expect(write?.input).toMatchObject({
      id: outreachId,
      attempt: 1,
      status: "failed",
    });
  });

  it("uses the next attempt and idempotency key after a failed row", async () => {
    const keys: string[] = [];
    const calls: Call[] = [];
    let attempts = 0;
    let sends = 0;
    const outreach = new CreatorHubOutreach({
      request: async (route, input) => {
        calls.push({ route, input });
        if (route.endsWith("outreach/submit")) {
          attempts++;
          return { ...approved, attempt: attempts };
        }
        if (route.endsWith("outreach/list"))
          return { items: [{ ...baseRow, attempt: attempts }] };
        if (route.endsWith("creatorhub/consent/get"))
          return { creatorhubAccountId: "7" };
        if (route.endsWith("lead/settings/get"))
          return {
            creatorhubBaseUrl: "http://127.0.0.1:1",
            creatorhubAccountId: "1",
          };
        return {};
      },
      client: () =>
        fakeClient({
          sendDm: async (input) => {
            keys.push(input.idempotencyKey);
            sends++;
            if (sends === 1)
              throw new PublishingError("CREATORHUB_REJECTED", "拒绝", 422);
            return { id: 21, status: "pending" };
          },
        }),
    });
    await rejection(outreach.submit({ analysisId, draft: "您好", requestKey }));
    const first = calls.find(
      (call) =>
        call.route.endsWith("outreach/result") &&
        call.input.status === "failed",
    );
    expect(first?.input).toMatchObject({ attempt: 1, status: "failed" });
    const result = await outreach.submit({
      analysisId,
      draft: "您好",
      requestKey: "s".repeat(32),
    });
    expect(result.status).toBe("submitted");
    expect(keys).toEqual([`ch-${outreachId}-1`, `ch-${outreachId}-2`]);
    const submitted = calls.find(
      (call) =>
        call.route.endsWith("outreach/result") &&
        call.input.status === "submitted",
    );
    expect(submitted?.input).toMatchObject({
      id: outreachId,
      attempt: 2,
      status: "submitted",
      creatorhubTaskId: "21",
    });
  });
});

describe("CreatorHubOutreach refresh", () => {
  it.each([
    ["done", "sent"],
    ["doing", "sending"],
    ["failed", "failed"],
    ["uncertain", "uncertain"],
    ["canceled", "canceled"],
  ])(
    "maps CreatorHub status %s to %s and writes the row attempt",
    async (taskStatus, expected) => {
      const calls: Call[] = [];
      const row = {
        ...baseRow,
        status: "submitted",
        attempt: 3,
        creatorhubTaskId: "42",
      };
      const outreach = new CreatorHubOutreach({
        request: scripted({ calls, rows: [row] }),
        client: () =>
          fakeClient({
            actions: async (accountId) => {
              expect(accountId).toBe(7);
              return [{ id: 42, status: taskStatus, error: "e".repeat(600) }];
            },
          }),
      });
      const result = await outreach.refresh({ outreachId, attempt: 3 });
      expect(result.status).toBe(expected);
      const write = calls.find((call) =>
        call.route.endsWith("outreach/result"),
      );
      expect(write?.input).toMatchObject({
        id: outreachId,
        attempt: 3,
        status: expected,
        creatorhubTaskId: "42",
      });
      expect(Array.from(String(write?.input.error))).toHaveLength(500);
    },
  );

  it("returns the current row without querying CreatorHub when the attempt is stale", async () => {
    let actions = 0;
    const calls: Call[] = [];
    const row = {
      ...baseRow,
      status: "submitted",
      attempt: 4,
      creatorhubTaskId: "42",
    };
    const outreach = new CreatorHubOutreach({
      request: scripted({ calls, rows: [row] }),
      client: () =>
        fakeClient({
          actions: async () => {
            actions++;
            return [];
          },
        }),
    });
    const result = await outreach.refresh({ outreachId, attempt: 3 });
    expect(result.attempt).toBe(4);
    expect(actions).toBe(0);
    expect(calls.some((call) => call.route.endsWith("outreach/result"))).toBe(
      false,
    );
  });
});

describe("CreatorHubOutreach confirm", () => {
  it("rejects a status other than sent or failed", async () => {
    const calls: Call[] = [];
    const outreach = new CreatorHubOutreach({
      request: scripted({
        calls,
        rows: [{ ...baseRow, status: "uncertain" }],
      }),
      client: () => fakeClient({}),
    });
    const error = await rejection(
      outreach.confirm({
        outreachId,
        attempt: 1,
        status: "done" as unknown as "sent",
      }),
    );
    expect(error).toMatchObject({ code: "INVALID_INPUT", status: 422 });
    expect(calls).toHaveLength(0);
  });

  it("rejects confirm with a stale attempt", async () => {
    const calls: Call[] = [];
    const outreach = new CreatorHubOutreach({
      request: scripted({
        calls,
        rows: [{ ...baseRow, status: "uncertain", attempt: 2 }],
      }),
      client: () => fakeClient({}),
    });
    const error = await rejection(
      outreach.confirm({ outreachId, attempt: 1, status: "sent" }),
    );
    expect(error).toMatchObject({ code: "OUTREACH_CHANGED", status: 409 });
    expect(calls.some((call) => call.route.endsWith("outreach/result"))).toBe(
      false,
    );
  });

  it("rejects confirm when the row is not uncertain", async () => {
    const calls: Call[] = [];
    const outreach = new CreatorHubOutreach({
      request: scripted({
        calls,
        rows: [{ ...baseRow, status: "submitted" }],
      }),
      client: () => fakeClient({}),
    });
    const error = await rejection(
      outreach.confirm({ outreachId, attempt: 1, status: "sent" }),
    );
    expect(error).toMatchObject({
      code: "OUTREACH_NOT_UNCERTAIN",
      status: 409,
    });
    expect(calls.some((call) => call.route.endsWith("outreach/result"))).toBe(
      false,
    );
  });

  it("confirms an uncertain row", async () => {
    const calls: Call[] = [];
    const outreach = new CreatorHubOutreach({
      request: scripted({
        calls,
        rows: [{ ...baseRow, status: "uncertain" }],
      }),
      client: () => fakeClient({}),
    });
    const result = await outreach.confirm({
      outreachId,
      attempt: 1,
      status: "failed",
    });
    expect(result.status).toBe("failed");
    expect(
      calls.find((call) => call.route.endsWith("outreach/result"))?.input,
    ).toEqual({
      id: outreachId,
      attempt: 1,
      status: "failed",
      confirmed: true,
    });
  });
});

describe("CreatorHubOutreach cancel", () => {
  it("rejects cancel before a CreatorHub task exists", async () => {
    let cancels = 0;
    const outreach = new CreatorHubOutreach({
      request: scripted({
        rows: [{ ...baseRow, status: "submitted", creatorhubTaskId: "" }],
      }),
      client: () =>
        fakeClient({
          cancelAction: async () => {
            cancels++;
            return { ok: true };
          },
        }),
    });
    const error = await rejection(outreach.cancel({ outreachId, attempt: 1 }));
    expect(error).toMatchObject({ code: "OUTREACH_NOT_SUBMITTED" });
    expect(cancels).toBe(0);
  });

  it("rejects cancel with a stale attempt", async () => {
    let cancels = 0;
    const outreach = new CreatorHubOutreach({
      request: scripted({
        rows: [
          {
            ...baseRow,
            status: "submitted",
            attempt: 2,
            creatorhubTaskId: "42",
          },
        ],
      }),
      client: () =>
        fakeClient({
          cancelAction: async () => {
            cancels++;
            return { ok: true };
          },
        }),
    });
    const error = await rejection(outreach.cancel({ outreachId, attempt: 1 }));
    expect(error).toMatchObject({ code: "OUTREACH_CHANGED", status: 409 });
    expect(cancels).toBe(0);
  });

  it("cancels the CreatorHub task and records the row attempt", async () => {
    const calls: Call[] = [];
    const ids: number[] = [];
    const outreach = new CreatorHubOutreach({
      request: scripted({
        calls,
        rows: [
          {
            ...baseRow,
            status: "submitted",
            attempt: 2,
            creatorhubTaskId: "42",
          },
        ],
      }),
      client: () =>
        fakeClient({
          cancelAction: async (id) => {
            ids.push(id);
            return { ok: true };
          },
        }),
    });
    const result = await outreach.cancel({ outreachId, attempt: 2 });
    expect(result.status).toBe("canceled");
    expect(ids).toEqual([42]);
    expect(
      calls.find((call) => call.route.endsWith("outreach/result"))?.input,
    ).toEqual({
      id: outreachId,
      attempt: 2,
      status: "canceled",
      creatorhubTaskId: "42",
    });
  });
});
