import { describe, expect, it, vi } from "vitest";
import { checkXhsLogin } from "./xhs";
import type { BrowserView } from "../../runtime/browser/browser-view";

describe("小红书登录", () => {
  it.each([
    [true, "logged_out", "logged_out"],
    [false, "logged_in", "logged_out"],
    [true, "verification_required", "verification_required"],
    [true, "logged_in", "logged_in"],
  ] as const)("会话 %s，首页 %s", async (session, marker, expected) => {
    const view = {
      createOpenCliPage: () => ({
        inspectDocument: async () => ({
          status: marker,
          id: "0123456789abcdef01234567",
        }),
      }),
      openOrReusePage: vi.fn(),
      getCookies: async () => (session ? [{ name: "web_session" }] : []),
    };
    const result = await checkXhsLogin(view as unknown as BrowserView);
    expect(result.status).toBe(expected);
    expect(result.accountId).toBe(
      expected === "logged_in" ? "0123456789abcdef01234567" : undefined,
    );
  });
});
