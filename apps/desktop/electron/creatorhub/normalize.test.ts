import { describe, expect, it } from "vitest";
import type { CreatorHubComment } from "./client";
import { normalizeComments } from "./normalize";

function comment(
  overrides: Partial<CreatorHubComment> = {},
): CreatorHubComment {
  return {
    comment_id: "c1",
    text: "想买房",
    user_nickname: "甲",
    user_sec_uid: "sec1",
    like_count: 3,
    create_time: 1700000000,
    is_reply: false,
    ...overrides,
  };
}

describe("normalizeComments", () => {
  it("keeps top-level comments and builds the profile URL", () => {
    const out = normalizeComments([
      comment(),
      comment({
        comment_id: "c2",
        text: "回复",
        user_nickname: "乙",
        user_sec_uid: "sec2",
        like_count: 0,
        create_time: 0,
        is_reply: true,
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].commenter_profile).toBe("https://www.douyin.com/user/sec1");
    expect(out[0].comment_time).toBe("2023-11-14T22:13:20.000Z");
    expect(out[0].reply_count).toBeNull();
  });

  it("skips replies, blank IDs, duplicate IDs, and overlong IDs", () => {
    const out = normalizeComments([
      comment({ comment_id: "c1" }),
      comment({ comment_id: "c1" }),
      comment({ comment_id: "   " }),
      comment({ comment_id: "x".repeat(1025) }),
      comment({ comment_id: "c2", is_reply: true }),
    ]);
    expect(out.map((row) => row.comment_id)).toEqual(["c1"]);
  });

  it("only builds profile URLs for simple sec_uids", () => {
    const out = normalizeComments([
      comment({ comment_id: "a", user_sec_uid: "Abc_123-x" }),
      comment({ comment_id: "b", user_sec_uid: "bad uid" }),
      comment({ comment_id: "c", user_sec_uid: "../evil" }),
      comment({ comment_id: "d", user_sec_uid: "   " }),
    ]);
    expect(out.map((row) => row.commenter_profile)).toEqual([
      "https://www.douyin.com/user/Abc_123-x",
      null,
      null,
      null,
    ]);
  });

  it("truncates long comment text and flags it", () => {
    const atLimit = normalizeComments([
      comment({ comment_id: "a", text: "好".repeat(8192) }),
    ]);
    expect(Array.from(atLimit[0].comment_text ?? "")).toHaveLength(8192);
    expect(atLimit[0].truncated).toBe(false);

    const overLimit = normalizeComments([
      comment({ comment_id: "b", text: "好".repeat(9000) }),
    ]);
    expect(Array.from(overLimit[0].comment_text ?? "")).toHaveLength(8192);
    expect(overLimit[0].truncated).toBe(true);
  });

  it("nulls invalid timestamps", () => {
    const out = normalizeComments([
      comment({ comment_id: "a", create_time: 0 }),
      comment({ comment_id: "b", create_time: -1 }),
      comment({ comment_id: "c", create_time: Number.NaN }),
      comment({ comment_id: "d", create_time: Number.POSITIVE_INFINITY }),
      comment({ comment_id: "e", create_time: 4_102_444_800 }),
    ]);
    expect(out.map((row) => row.comment_time)).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it("nulls negative and unsafe like counts", () => {
    const out = normalizeComments([
      comment({ comment_id: "a", like_count: -1 }),
      comment({ comment_id: "b", like_count: Number.MAX_SAFE_INTEGER + 1 }),
      comment({ comment_id: "c", like_count: Number.NaN }),
      comment({ comment_id: "d", like_count: Number.MAX_SAFE_INTEGER }),
    ]);
    expect(out.map((row) => row.like_count)).toEqual([
      null,
      null,
      null,
      Number.MAX_SAFE_INTEGER,
    ]);
  });

  it("nulls blank text and nicknames and truncates long nicknames", () => {
    const out = normalizeComments([
      comment({ comment_id: "a", text: "   ", user_nickname: "  " }),
      comment({ comment_id: "b", user_nickname: "名".repeat(300) }),
    ]);
    expect(out[0].comment_text).toBeNull();
    expect(out[0].commenter_name).toBeNull();
    expect(out[1].commenter_name).toHaveLength(256);
  });
});
