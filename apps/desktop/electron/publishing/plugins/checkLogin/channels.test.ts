import { afterEach, describe, expect, it, vi } from "vitest";
import { channelsSelf } from "./channels";

afterEach(() => vi.unstubAllGlobals());
describe("视频号助手当前账号", () => {
  function page(
    userStore: unknown,
    url = "https://channels.weixin.qq.com/platform/post/create",
    qr = false,
  ) {
    vi.stubGlobal("location", new URL(url));
    vi.stubGlobal("window", { _store: { userStore } });
    vi.stubGlobal("document", {
      querySelectorAll: () => (qr ? [{ getClientRects: () => [1] }] : []),
    });
  }
  it("只读取活动视频号的身份", () => {
    page({
      finderUsername: "wxA@finder",
      finderNickname: "甲",
      user: { username: "operator" },
    });
    expect(channelsSelf()).toEqual({
      status: "logged_in",
      id: "wxA@finder",
      nickname: "甲",
    });
    page({ user: { username: "operator" }, finderNickname: "甲" });
    expect(channelsSelf().status).toBe("unknown");
  });
  it("过期、扫码页和其他网站的残留标识不能用于投稿", () => {
    page({ finderUsername: "old", isExpired: true });
    expect(channelsSelf().status).toBe("expired");
    page({ finderUsername: "old" }, undefined, true);
    expect(channelsSelf().status).toBe("logged_out");
    page({ finderUsername: "old" }, "https://example.org/platform");
    expect(channelsSelf().status).toBe("unknown");
  });
});
