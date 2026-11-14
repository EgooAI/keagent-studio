import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { PublishingError } from "../publishing/core";
import { CreatorHubClient, type CreatorHubComment } from "./client";

type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
) => void | Promise<void>;
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

async function start(handler: Handler) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return { server, base: `http://127.0.0.1:${address.port}` };
}

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function rejectOnConstruction(raw: string): PublishingError {
  try {
    new CreatorHubClient(raw);
  } catch (error) {
    return error as PublishingError;
  }
  throw new Error(`expected "${raw}" to be rejected`);
}

async function rejection(promise: Promise<unknown>): Promise<PublishingError> {
  try {
    await promise;
  } catch (error) {
    return error as PublishingError;
  }
  throw new Error("expected the client call to reject");
}

function commentRow(commentId: string): CreatorHubComment {
  return {
    comment_id: commentId,
    text: commentId,
    user_nickname: "甲",
    user_sec_uid: "sec",
    like_count: 0,
    create_time: 0,
    is_reply: false,
  };
}

describe("CreatorHubClient", () => {
  it.each([
    "https://example.com",
    "http://example.com:8000",
    "http://user:pass@127.0.0.1:8000",
    "http://127.0.0.1:8000/?query=1",
    "http://127.0.0.1:8000/#hash",
    "http://127.0.0.1:8000/api",
    "not a url",
  ])("rejects non-loopback base URL %s", (raw) => {
    const error = rejectOnConstruction(raw);
    expect(error).toBeInstanceOf(PublishingError);
    expect(error.code).toBe("CREATORHUB_URL_INVALID");
    expect(error.status).toBe(422);
  });

  it.each(["http://localhost:8000", "http://[::1]:8000"])(
    "accepts loopback base URL %s",
    (raw) => {
      expect(() => new CreatorHubClient(raw)).not.toThrow();
    },
  );

  it("sends the expected idempotent DM request", async () => {
    let method = "";
    let path = "";
    let idempotencyKey = "";
    let contentType = "";
    let body = "";
    const { base } = await start(async (req, res) => {
      method = req.method ?? "";
      path = req.url ?? "";
      idempotencyKey = String(req.headers["idempotency-key"] ?? "");
      contentType = String(req.headers["content-type"] ?? "");
      body = await readBody(req);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: 7, status: "pending" }));
    });
    const client = new CreatorHubClient(base);
    const result = await client.sendDm({
      accountId: 1,
      targetSecUid: "sec",
      targetNick: "甲",
      content: "您好",
      idempotencyKey: "ch-0123456789abcdef0123456789abcdef-1",
    });
    expect(result).toEqual({ id: 7, status: "pending" });
    expect(method).toBe("POST");
    expect(path).toBe("/api/account-actions");
    expect(idempotencyKey).toBe("ch-0123456789abcdef0123456789abcdef-1");
    expect(contentType).toBe("application/json");
    expect(JSON.parse(body)).toMatchObject({
      account_id: 1,
      action: "send_dm",
      target_sec_uid: "sec",
      target_nick: "甲",
      content: "您好",
      run_now: false,
    });
  });

  it("paginates comments and merges pages", async () => {
    const pages: string[] = [];
    const watches: string[] = [];
    const pageSizes: string[] = [];
    const { base } = await start((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      pages.push(url.searchParams.get("page") ?? "");
      watches.push(url.searchParams.get("watch_id") ?? "");
      pageSizes.push(url.searchParams.get("page_size") ?? "");
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          items: [commentRow(`c${pages.length}`)],
          has_next: pages.length === 1,
        }),
      );
    });
    const client = new CreatorHubClient(base);
    const rows = await client.comments(5);
    expect(rows.map((row) => row.comment_id)).toEqual(["c1", "c2"]);
    expect(pages).toEqual(["1", "2"]);
    expect(watches).toEqual(["5", "5"]);
    expect(pageSizes).toEqual(["200", "200"]);
  });

  it("stops paginating when a page is empty", async () => {
    let requests = 0;
    const { base } = await start((req, res) => {
      requests++;
      const url = new URL(req.url ?? "/", "http://localhost");
      const page = Number(url.searchParams.get("page"));
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          items: page === 1 ? [commentRow("c1")] : [],
          has_next: true,
        }),
      );
    });
    const client = new CreatorHubClient(base);
    const rows = await client.comments(1);
    expect(rows.map((row) => row.comment_id)).toEqual(["c1"]);
    expect(requests).toBe(2);
  });

  it("caps comment pagination at twenty pages", async () => {
    let requests = 0;
    const { base } = await start((req, res) => {
      requests++;
      const url = new URL(req.url ?? "/", "http://localhost");
      const page = url.searchParams.get("page");
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          items: [commentRow(`c${page}`)],
          has_next: true,
        }),
      );
    });
    const client = new CreatorHubClient(base);
    const rows = await client.comments(1);
    expect(rows).toHaveLength(20);
    expect(requests).toBe(20);
  });

  it("requests account actions with a bounded limit", async () => {
    const paths: string[] = [];
    const { base } = await start((req, res) => {
      paths.push(req.url ?? "");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify([]));
    });
    const client = new CreatorHubClient(base);
    await client.actions(5);
    await client.actions(5, 1000);
    expect(paths).toEqual([
      "/api/account-actions?account_id=5&limit=100",
      "/api/account-actions?account_id=5&limit=1000",
    ]);
  });

  it("maps a non-JSON success body to CREATORHUB_INVALID_RESPONSE", async () => {
    const { base } = await start((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end("not-json");
    });
    const error = await rejection(new CreatorHubClient(base).health());
    expect(error).toBeInstanceOf(PublishingError);
    expect(error.code).toBe("CREATORHUB_INVALID_RESPONSE");
    expect(error.status).toBe(502);
  });

  it("returns null for an empty success body", async () => {
    const { base } = await start((_req, res) => {
      res.statusCode = 200;
      res.end();
    });
    await expect(new CreatorHubClient(base).health()).resolves.toBeNull();
  });

  it("maps a JSON error detail to CREATORHUB_REJECTED", async () => {
    const { base } = await start((_req, res) => {
      res.statusCode = 409;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ detail: "账号未登录" }));
    });
    const error = await rejection(new CreatorHubClient(base).accounts());
    expect(error).toBeInstanceOf(PublishingError);
    expect(error.code).toBe("CREATORHUB_REJECTED");
    expect(error.message).toBe("账号未登录");
    expect(error.status).toBe(409);
  });

  it("maps a non-JSON error body to a generic rejection", async () => {
    const { base } = await start((_req, res) => {
      res.statusCode = 500;
      res.end("boom");
    });
    const error = await rejection(new CreatorHubClient(base).accounts());
    expect(error.code).toBe("CREATORHUB_REJECTED");
    expect(error.message).toBe("CreatorHub 拒绝了请求");
    expect(error.status).toBe(500);
  });

  it("maps a stalled response to CREATORHUB_TIMEOUT", async () => {
    const { base } = await start(() => {
      // Intentionally never respond.
    });
    const error = await rejection(new CreatorHubClient(base).health());
    expect(error).toBeInstanceOf(PublishingError);
    expect(error.code).toBe("CREATORHUB_TIMEOUT");
    expect(error.status).toBe(503);
  }, 10_000);

  it("maps a stalled body read to CREATORHUB_TIMEOUT", async () => {
    const { base } = await start((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"status":');
    });
    const error = await rejection(new CreatorHubClient(base).health());
    expect(error).toBeInstanceOf(PublishingError);
    expect(error.code).toBe("CREATORHUB_TIMEOUT");
    expect(error.status).toBe(503);
  }, 10_000);

  it.each([302, 307])("does not follow a %i redirect", async (status) => {
    let targetHits = 0;
    const target = await start((_req, res) => {
      targetHits++;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: "up" }));
    });
    const source = await start((_req, res) => {
      res.statusCode = status;
      res.setHeader("location", `${target.base}/health`);
      res.end();
    });
    const error = await rejection(new CreatorHubClient(source.base).health());
    expect(error).toBeInstanceOf(PublishingError);
    expect(error.code).toBe("CREATORHUB_UNAVAILABLE");
    expect(targetHits).toBe(0);
  });
});
