import { describe, expect, it } from "vitest";
import { normalizeComments } from "./normalize";

describe("normalizeComments", () => {
  it("keeps top-level comments and builds the profile URL", () => {
    const out = normalizeComments([
      {
        comment_id: "c1",
        text: "想买房",
        user_nickname: "甲",
        user_sec_uid: "sec1",
        like_count: 3,
        create_time: 1700000000,
        is_reply: false,
      },
      {
        comment_id: "c2",
        text: "回复",
        user_nickname: "乙",
        user_sec_uid: "sec2",
        like_count: 0,
        create_time: 0,
        is_reply: true,
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].commenter_profile).toBe("https://www.douyin.com/user/sec1");
    expect(out[0].comment_time).toBe("2023-11-14T22:13:20.000Z");
    expect(out[0].reply_count).toBeNull();
  });
});
