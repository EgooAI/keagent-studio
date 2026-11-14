import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { CreatorHubBridge } from "./bridge";
import { CreatorHubClient } from "./client";

let server: ReturnType<typeof createServer> | undefined;
afterEach(() => server?.close());

async function fixture() {
  const calls: Array<{ route: string; input: unknown }> = [];
  let loginPolls = 0;
  server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/health") return res.end(JSON.stringify({ status: "ok" }));
    if (req.url?.startsWith("/api/accounts"))
      return res.end(
        JSON.stringify([
          {
            id: 1,
            platform: "douyin",
            nickname: "甲",
            status: "active",
            has_read_login: true,
          },
        ]),
      );
    if (req.url?.startsWith("/api/login/browser/start"))
      return res.end(JSON.stringify({ task_id: "t1" }));
    if (req.url?.startsWith("/api/login/browser/poll")) {
      loginPolls++;
      return res.end(JSON.stringify({ status: "confirmed" }));
    }
    if (req.url?.startsWith("/api/comment-watches/resolve"))
      return res.end(
        JSON.stringify({ aweme_id: "7".repeat(19), title: "视频" }),
      );
    if (req.url?.startsWith("/api/comment-watches?"))
      return res.end(JSON.stringify([]));
    if (req.url === "/api/comment-watches" && req.method === "POST")
      return res.end(
        JSON.stringify({
          id: 1,
          aweme_id: "7".repeat(19),
          account_id: 1,
          group_name: "creatorhub",
          enabled: true,
        }),
      );
    if (req.url?.endsWith("/scan-now"))
      return res.end(JSON.stringify({ ok: true }));
    if (req.url?.startsWith("/api/comments"))
      return res.end(
        JSON.stringify({
          items: [
            {
              comment_id: "c1",
              text: "想买房",
              user_nickname: "甲",
              user_sec_uid: "sec1",
              like_count: 1,
              create_time: 1700000000,
              is_reply: false,
            },
          ],
          has_next: false,
        }),
      );
    return res.end(JSON.stringify({}));
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const bridge = new CreatorHubBridge({
    request: async (route, input) => {
      calls.push({ route, input });
      return route.endsWith("lead/settings/get")
        ? {
            creatorhubBaseUrl: `http://127.0.0.1:${port}`,
            creatorhubAccountId: "1",
          }
        : route.endsWith("comments/import")
          ? { readCount: 1, addedCount: 1, updatedCount: 0 }
          : {};
    },
    client: (baseUrl) => new CreatorHubClient(baseUrl),
  });
  return { bridge, calls, loginPolls: () => loginPolls };
}

describe("CreatorHubBridge", () => {
  it("returns ready status and accounts", async () => {
    const { bridge } = await fixture();
    const status = await bridge.status();
    expect(status.health).toBe("ready");
    expect(status.accounts).toEqual([
      { id: "1", nickname: "甲", status: "active", has_read_login: true },
    ]);
  });

  it("polls login to confirmed", async () => {
    const { bridge, loginPolls } = await fixture();
    const status = await bridge.login();
    expect(loginPolls()).toBeGreaterThan(0);
    expect(status.health).toBe("ready");
  });

  it("runs the fetch and import sequence", async () => {
    const { bridge, calls } = await fixture();
    const result = await bridge.start({
      url: "https://v.douyin.com/x/",
      accountId: "1",
      requestKey: "k".repeat(32),
      consent: { accepted: true },
    });
    expect(result.addedCount).toBe(1);
    expect(result.coverage).toBe("partial");
    expect(calls.map((call) => call.route)).toContain(
      "/v1/collection/comments/import",
    );
    expect(calls.map((call) => call.route)).toContain(
      "/v1/collection/creatorhub/consent/save",
    );
  });
});
