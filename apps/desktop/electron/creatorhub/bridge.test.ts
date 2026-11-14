import { createHash } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { PublishingError } from "../publishing/core";
import {
  CreatorHubClient,
  type CreatorHubAccount,
  type CreatorHubComment,
  type CreatorHubWatch,
} from "./client";
import { CreatorHubBridge, type BridgeDependencies } from "./bridge";

type Server = ReturnType<typeof createServer>;
type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
) => void | Promise<void>;

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

async function serve(handler: Handler) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return `http://127.0.0.1:${address.port}`;
}

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

const WORK_ID = "7".repeat(19);
const REQUEST_KEY = "k".repeat(32);

const ACCOUNT: CreatorHubAccount = {
  id: 1,
  platform: "douyin",
  nickname: "甲",
  status: "active",
  has_read_login: true,
  sec_uid: "sec1",
};

const COMMENT: CreatorHubComment = {
  comment_id: "c1",
  text: "想买房",
  user_nickname: "甲",
  user_sec_uid: "sec1",
  like_count: 1,
  create_time: 1700000000,
  is_reply: false,
};

function watch(overrides: Partial<CreatorHubWatch> = {}): CreatorHubWatch {
  return {
    id: 9,
    platform: "douyin",
    kind: "video",
    aweme_id: WORK_ID,
    account_id: 1,
    title: "视频",
    group_name: "creatorhub",
    enabled: false,
    ...overrides,
  };
}

function startInput() {
  return {
    url: "https://v.douyin.com/x/",
    accountId: "1",
    requestKey: REQUEST_KEY,
    consent: { accepted: true },
  };
}

async function rejectionOf(
  promise: Promise<unknown>,
): Promise<PublishingError> {
  try {
    await promise;
  } catch (error) {
    return error as PublishingError;
  }
  throw new Error("expected the promise to reject");
}

function expectCode(error: PublishingError, code: string) {
  expect(error).toBeInstanceOf(PublishingError);
  expect(error.code).toBe(code);
}

interface FixtureOptions {
  accounts?: CreatorHubAccount[];
  healthFails?: boolean;
  watches?: CreatorHubWatch[];
  createConflict?: boolean;
  scan?: unknown;
  comments?: CreatorHubComment[];
  identity?: BridgeDependencies["identity"] | null;
  client?: (baseUrl: string) => CreatorHubClient;
}

async function fixture(options: FixtureOptions = {}) {
  const calls: Array<{ route: string; input: unknown }> = [];
  const paths: string[] = [];
  const disabledWatches: number[] = [];
  const watches = [...(options.watches ?? [])];
  let createWatchBody: unknown;
  let loginPolls = 0;

  const baseUrl = await serve(async (req, res) => {
    res.setHeader("content-type", "application/json");
    paths.push(`${req.method} ${req.url}`);
    if (req.url === "/health") {
      if (options.healthFails) {
        res.statusCode = 503;
        res.end(JSON.stringify({ status: "down" }));
        return;
      }
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (req.url?.startsWith("/api/accounts")) {
      res.end(JSON.stringify(options.accounts ?? [ACCOUNT]));
      return;
    }
    if (req.url?.startsWith("/api/login/browser/start")) {
      res.end(JSON.stringify({ task_id: "t1" }));
      return;
    }
    if (req.url?.startsWith("/api/login/browser/poll")) {
      loginPolls++;
      res.end(JSON.stringify({ status: "confirmed" }));
      return;
    }
    if (req.url?.startsWith("/api/comment-watches/resolve")) {
      res.end(JSON.stringify({ aweme_id: WORK_ID, title: "视频" }));
      return;
    }
    if (req.url?.startsWith("/api/comment-watches?") && req.method === "GET") {
      res.end(JSON.stringify(watches));
      return;
    }
    if (req.url === "/api/comment-watches" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}") as {
        account_id?: number;
      };
      createWatchBody = body;
      if (options.createConflict) {
        watches.push(watch({ id: 11 }));
        res.statusCode = 409;
        res.end(JSON.stringify({ detail: "该视频已被监控" }));
        return;
      }
      const created = watch({ id: 11, account_id: body.account_id ?? 1 });
      watches.push(created);
      res.end(JSON.stringify(created));
      return;
    }
    if (req.url?.startsWith("/api/comment-watches/") && req.method === "PUT") {
      const id = Number(req.url.split("/")[3]);
      disabledWatches.push(id);
      res.end(JSON.stringify(watch({ id, enabled: false })));
      return;
    }
    if (req.url?.endsWith("/scan-now")) {
      res.end(JSON.stringify(options.scan ?? { ok: true }));
      return;
    }
    if (req.url?.startsWith("/api/comments")) {
      res.end(
        JSON.stringify({
          items: options.comments ?? [COMMENT],
          has_next: false,
        }),
      );
      return;
    }
    res.end(JSON.stringify({}));
  });

  const deps: BridgeDependencies = {
    request: async (route, input) => {
      calls.push({ route, input });
      return route.endsWith("lead/settings/get")
        ? { creatorhubBaseUrl: baseUrl, creatorhubAccountId: "1" }
        : route.endsWith("comments/import")
          ? { readCount: 1, addedCount: 1, updatedCount: 0 }
          : {};
    },
    client: options.client ?? ((url) => new CreatorHubClient(url)),
  };
  if (options.identity !== null)
    deps.identity =
      options.identity ?? (async () => ({ userId: "u1", deviceId: "d1" }));

  return {
    bridge: new CreatorHubBridge(deps),
    calls,
    paths,
    disabledWatches,
    createWatchBody: () => createWatchBody,
    loginPolls: () => loginPolls,
  };
}

describe("CreatorHubBridge", () => {
  it("returns ready status and accounts", async () => {
    const { bridge } = await fixture();
    const status = await bridge.status();
    expect(status.health).toBe("ready");
    expect(status.accounts).toEqual([
      { id: "1", nickname: "甲", status: "active", has_read_login: true },
    ]);
    expect(status.selectedAccountId).toBe("1");
  });

  it("returns offline status when health fails", async () => {
    const { bridge } = await fixture({ healthFails: true });
    const status = await bridge.status();
    expect(status).toEqual({
      health: "offline",
      accounts: [],
      selectedAccountId: "1",
      progress: "",
    });
  });

  it("polls login to confirmed", async () => {
    const { bridge, loginPolls } = await fixture();
    const status = await bridge.login();
    expect(loginPolls()).toBeGreaterThan(0);
    expect(status.health).toBe("ready");
  });

  it("runs the fetch and import sequence", async () => {
    const { bridge, calls, disabledWatches, createWatchBody } = await fixture();
    const result = await bridge.start(startInput());
    expect(result.addedCount).toBe(1);
    expect(result.coverage).toBe("partial");
    expect(result.warning).toBeUndefined();
    const routes = calls.map((call) => call.route);
    const consent = routes.indexOf("/v1/collection/creatorhub/consent/save");
    const imported = routes.indexOf("/v1/collection/comments/import");
    expect(consent).toBeGreaterThanOrEqual(0);
    expect(imported).toBeGreaterThan(consent);
    const linked = createHash("sha256")
      .update("creatorhub:u1:d1:1")
      .digest("hex")
      .slice(0, 32);
    const bind = calls.find(
      (call) => call.route === "/v1/douyin/accounts/bind",
    );
    expect(bind?.input).toMatchObject({
      id: linked,
      loginStatus: "logged_in",
      platformUserId: "sec1",
    });
    expect(result.accountId).toBe(linked);
    expect(createWatchBody()).toMatchObject({
      url_or_id: WORK_ID,
      account_id: 1,
    });
    expect(disabledWatches).toEqual([11]);
  });

  it("rejects before any HTTP or Go call without consent", async () => {
    const { bridge, calls, paths } = await fixture();
    const error = await rejectionOf(
      bridge.start({ ...startInput(), consent: { accepted: false } }),
    );
    expectCode(error, "CONSENT_REQUIRED");
    expect(calls).toEqual([]);
    expect(paths).toEqual([]);
  });

  it("requires an identity provider", async () => {
    const { bridge, calls } = await fixture({ identity: null });
    const error = await rejectionOf(bridge.start(startInput()));
    expectCode(error, "IDENTITY_UNAVAILABLE");
    expect(calls).toEqual([]);
  });

  it("rejects empty identity values", async () => {
    const { bridge, calls } = await fixture({
      identity: async () => ({ userId: "", deviceId: "d1" }),
    });
    const error = await rejectionOf(bridge.start(startInput()));
    expectCode(error, "IDENTITY_UNAVAILABLE");
    expect(calls).toEqual([]);
  });

  it("rejects a concurrent start", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { bridge } = await fixture({
      identity: async () => {
        await gate;
        return { userId: "u1", deviceId: "d1" };
      },
    });
    const first = bridge.start(startInput());
    await Promise.resolve();
    const busy = await rejectionOf(bridge.start(startInput()));
    expectCode(busy, "CREATORHUB_BUSY");
    release();
    const result = await first;
    expect(result.addedCount).toBe(1);
  });

  it("reuses an existing watch without disabling it", async () => {
    const { bridge, createWatchBody, disabledWatches, paths } = await fixture({
      watches: [watch({ id: 9 })],
    });
    const result = await bridge.start(startInput());
    expect(result.watchId).toBe(9);
    expect(disabledWatches).toEqual([]);
    expect(createWatchBody()).toBeUndefined();
    expect(paths).not.toContain("POST /api/comment-watches");
  });

  it("prefers a watch owned by the selected account", async () => {
    const { bridge } = await fixture({
      watches: [
        watch({ id: 9, account_id: 2 }),
        watch({ id: 10, account_id: 1 }),
      ],
    });
    const result = await bridge.start(startInput());
    expect(result.watchId).toBe(10);
  });

  it("reuses a watch created under another account", async () => {
    const { bridge, createWatchBody } = await fixture({
      watches: [watch({ id: 9, account_id: 2 })],
    });
    const result = await bridge.start(startInput());
    expect(result.watchId).toBe(9);
    expect(createWatchBody()).toBeUndefined();
  });

  it("re-fetches and reuses when watch creation conflicts", async () => {
    const { bridge, createWatchBody, disabledWatches } = await fixture({
      createConflict: true,
    });
    const result = await bridge.start(startInput());
    expect(result.watchId).toBe(11);
    expect(createWatchBody()).toMatchObject({ url_or_id: WORK_ID });
    expect(disabledWatches).toEqual([]);
  });

  it("rejects when the scan reports failure", async () => {
    const { bridge, calls } = await fixture({
      scan: { ok: false, error: "抓取失败" },
    });
    const error = await rejectionOf(bridge.start(startInput()));
    expectCode(error, "CREATORHUB_SCAN_FAILED");
    expect(error.message).toBe("抓取失败");
    expect(calls.map((call) => call.route)).not.toContain(
      "/v1/collection/comments/import",
    );
  });

  it("rejects when the scan has no explicit success", async () => {
    const { bridge, calls } = await fixture({ scan: {} });
    const error = await rejectionOf(bridge.start(startInput()));
    expectCode(error, "CREATORHUB_SCAN_FAILED");
    expect(calls.map((call) => call.route)).not.toContain(
      "/v1/collection/comments/import",
    );
  });

  it("rejects when the scan is skipped", async () => {
    const { bridge } = await fixture({
      scan: { skipped: true, reason: "冷却中" },
    });
    const error = await rejectionOf(bridge.start(startInput()));
    expectCode(error, "CREATORHUB_SCAN_SKIPPED");
    expect(error.message).toBe("冷却中");
  });

  it("imports stored comments with a warning when the scan times out", async () => {
    const { bridge, calls } = await fixture({
      client: () =>
        ({
          health: async () => ({ status: "ok" }),
          accounts: async () => [ACCOUNT],
          resolve: async () => ({ aweme_id: WORK_ID, title: "视频" }),
          watches: async () => [watch({ id: 9 })],
          createWatch: async () => {
            throw new Error("unexpected createWatch");
          },
          disableWatch: async () => {
            throw new Error("unexpected disableWatch");
          },
          scan: async () => {
            throw new PublishingError(
              "CREATORHUB_TIMEOUT",
              "CreatorHub 响应超时",
              503,
            );
          },
          comments: async () => [COMMENT],
        }) as unknown as CreatorHubClient,
    });
    const result = await bridge.start(startInput());
    expect(result.warning).toBe("抓取超时，已导入现有评论");
    expect(result.coverage).toBe("partial");
    expect(calls.map((call) => call.route)).toContain(
      "/v1/collection/comments/import",
    );
  });

  it("rejects when the video has no first-level comments", async () => {
    const { bridge, calls } = await fixture({ comments: [] });
    const error = await rejectionOf(bridge.start(startInput()));
    expectCode(error, "CREATORHUB_NO_COMMENTS");
    expect(calls.map((call) => call.route)).not.toContain(
      "/v1/collection/comments/import",
    );
  });

  it("rejects when the selected account is missing", async () => {
    const { bridge, calls } = await fixture({ accounts: [] });
    const error = await rejectionOf(bridge.start(startInput()));
    expectCode(error, "CREATORHUB_ACCOUNT_UNAVAILABLE");
    expect(calls.map((call) => call.route)).not.toContain(
      "/v1/douyin/accounts/bind",
    );
  });

  it("rejects when the selected account is inactive", async () => {
    const { bridge } = await fixture({
      accounts: [{ ...ACCOUNT, status: "inactive" }],
    });
    const error = await rejectionOf(bridge.start(startInput()));
    expectCode(error, "CREATORHUB_ACCOUNT_UNAVAILABLE");
  });
});
