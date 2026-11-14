import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { CreatorHubClient } from "./client";
import { CreatorHubOutreach } from "./outreach";

let server: ReturnType<typeof createServer> | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

describe("CreatorHubOutreach", () => {
  it("submits with the per-attempt idempotency key and records the task", async () => {
    let key = "";
    server = createServer((req, res) => {
      key = String(req.headers["idempotency-key"] || "");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: 9, status: "pending" }));
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as { port: number }).port;
    const calls: Array<{ route: string; input: any }> = [];
    const outreach = new CreatorHubOutreach({
      request: async (route, input) => {
        calls.push({ route, input });
        if (route.endsWith("lead/settings/get"))
          return {
            creatorhubBaseUrl: `http://127.0.0.1:${port}`,
            creatorhubAccountId: "1",
          };
        if (route.endsWith("outreach/submit"))
          return {
            id: "o".repeat(32),
            attempt: 1,
            status: "approved",
            commenterProfile: "https://www.douyin.com/user/sec1",
            commenterName: "甲",
          };
        return {};
      },
      client: (baseUrl) => new CreatorHubClient(baseUrl),
    });
    const result = await outreach.submit({
      analysisId: "a".repeat(32),
      draft: "您好",
      requestKey: "r".repeat(32),
      creatorHubAccountId: "1",
    });
    expect(result.status).toBe("submitted");
    expect(key).toBe(`ch-${"o".repeat(32)}-1`);
    const resultCall = calls.find((call) =>
      call.route.endsWith("outreach/result"),
    );
    expect(resultCall?.input).toMatchObject({
      id: "o".repeat(32),
      attempt: 1,
      status: "submitted",
      creatorhubTaskId: "9",
      method: "browser",
    });
  });
});
