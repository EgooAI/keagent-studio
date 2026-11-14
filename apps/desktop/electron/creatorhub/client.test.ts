import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { CreatorHubClient } from "./client";

let server: ReturnType<typeof createServer> | undefined;
afterEach(() => server?.close());

describe("CreatorHubClient", () => {
  it("rejects non-loopback base URLs", () => {
    expect(() => new CreatorHubClient("https://example.com")).toThrow();
    expect(() => new CreatorHubClient("http://example.com:8000")).toThrow();
    expect(() => new CreatorHubClient("http://127.0.0.1:8000/api")).toThrow();
  });
  it("sends idempotent DM requests", async () => {
    let received = "";
    server = createServer((req, res) => {
      received = req.headers["idempotency-key"] as string;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: 7, status: "pending" }));
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const client = new CreatorHubClient(`http://127.0.0.1:${address.port}`);
    const result = await client.sendDm({
      accountId: 1,
      targetSecUid: "sec",
      targetNick: "甲",
      content: "您好",
      idempotencyKey: "ch-0123456789abcdef0123456789abcdef-1",
    });
    expect(result.id).toBe(7);
    expect(received).toBe("ch-0123456789abcdef0123456789abcdef-1");
  });
});
