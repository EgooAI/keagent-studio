import { describe, expect, it, vi } from "vitest";
import type { OpenCliPage } from "../publishing/runtime/browser/opencli-page";
import {
  collectWorkComments,
  commentTarget,
  matchesCommentPage,
  parseCommentPage,
  resolveCommentTarget,
} from "./comments";

const id = "7799101234567890123";
const note = "67b32410000000001100aaaa";
const dyUrl = "https://www.douyin.com/video/" + id;
const api = new URL(
  "https://www.douyin.com/aweme/v1/web/comment/list/?cursor=0&aweme_id=" + id,
);
describe("works read through the selected Electron profile", () => {
  it("opens the selected Jingxuan work at its canonical URL", async () => {
    const workId = "7705373735628393770";
    const page = "https://www.douyin.com/jingxuan";
    await expect(
      resolveCommentTarget("douyin", page + "?modal_id=" + workId),
    ).resolves.toEqual({
      workId,
      url: "https://www.douyin.com/video/" + workId,
    });
    for (const url of [
      page,
      page + "?modal_id=abc",
      page + "?modal_id=" + workId + "&modal_id=12345",
      page.replace("douyin.com", "douyin.com.example") + "?modal_id=" + workId,
    ])
      await expect(resolveCommentTarget("douyin", url)).rejects.toThrow();
  });
  it("expands shared works on official hosts without sending credentials or following external redirects", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://www.iesdouyin.com/share/video/" + id },
        }),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://other.example/work" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(
        resolveCommentTarget(
          "douyin",
          "分享视频 https://v.douyin.com/abc/ 复制打开",
        ),
      ).resolves.toMatchObject({ workId: id });
      await expect(resolveCommentTarget("douyin", id)).resolves.toMatchObject({
        url: dyUrl,
      });
      await expect(
        resolveCommentTarget("xhs", "分享笔记 http://xhslink.com/a/abc"),
      ).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][1]).toMatchObject({
        redirect: "manual",
        credentials: "omit",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("keeps loaded replies attached to their root across both platforms", () => {
    const dy = parseCommentPage("douyin", id, {
      status_code: 0,
      comments: [{ cid: "one", reply_comment: [{ cid: "two" }] }],
    });
    expect(dy.items.map((row) => row.parent_comment_id)).toEqual([null, "one"]);
    const xhs = parseCommentPage("xhs", note, {
      code: 0,
      data: {
        comments: [
          {
            id: "one",
            sub_comments: [{ id: "two", user_info: { user_id: "invalid-id" } }],
          },
        ],
      },
    });
    expect(xhs.items[1]).toMatchObject({
      parent_comment_id: "one",
      commenter_profile: null,
    });
  });
  it("limits navigation and captured pages to the exact platform and work", () => {
    expect(commentTarget("douyin", dyUrl)).toEqual({ workId: id, url: dyUrl });
    const noteUrl =
      "https://www.xiaohongshu.com/explore/" + note + "?xsec_token=link-token";
    expect(commentTarget("xhs", noteUrl + "&tracking=unused").url).toBe(
      noteUrl,
    );
    expect(() =>
      commentTarget("xhs", noteUrl.replace("www.", "evil.")),
    ).toThrow();
    expect(() => commentTarget("douyin", noteUrl)).toThrow();
    expect(matchesCommentPage("douyin", id, api)).toBe(true);
    const routed = new URL(api);
    routed.hostname = "www-hj.douyin.com";
    expect(matchesCommentPage("douyin", id, routed)).toBe(true);
    expect(matchesCommentPage("douyin", id + "1", routed)).toBe(false);
    routed.hostname += ".example";
    expect(matchesCommentPage("douyin", id, routed)).toBe(false);
    expect(matchesCommentPage("douyin", id + "1", api)).toBe(false);
    expect(
      matchesCommentPage(
        "douyin",
        id,
        new URL(api.href.replace("/list/", "/list/reply/")),
      ),
    ).toBe(false);
    expect(
      matchesCommentPage(
        "xhs",
        note,
        new URL(
          "https://edith.xiaohongshu.com/api/sns/web/v2/comment/page?note_id=" +
            note,
        ),
      ),
    ).toBe(true);
  });
  it("normalizes parent comments without fabricating missing or zero values", () => {
    const result = parseCommentPage("xhs", note, {
      code: 0,
      success: true,
      data: {
        comments: [
          {
            id: "c1",
            note_id: note,
            content: "hi",
            user_info: { user_id: note, nickname: "谁" },
            like_count: "0",
            sub_comment_count: 1,
            create_time: 1730000000000,
          },
        ],
        has_more: false,
      },
    });
    expect(result.last).toBe(true);
    expect(result.items[0]).toMatchObject({
      commenter_profile: "https://www.xiaohongshu.com/user/profile/" + note,
      comment_text: "hi",
      like_count: 0,
      reply_count: 1,
      comment_time: "2024-10-27T03:33:20.000Z",
    });
    expect(
      parseCommentPage("douyin", id, {
        status_code: 0,
        comments: [
          { cid: "c2", text: "hello", user: { nickname: "n", sec_uid: "abc" } },
        ],
        has_more: 1,
      }).items[0],
    ).toMatchObject({
      comment_id: "c2",
      commenter_name: "n",
      like_count: null,
    });
    expect(() =>
      parseCommentPage("xhs", note, {
        code: 0,
        data: { comments: [{ id: "c1", note_id: "other" }] },
      }),
    ).toThrow();
    expect(() =>
      parseCommentPage("douyin", id, {
        status_code: 8,
        comments: [],
        has_more: 0,
      }),
    ).toThrow();
  });
  it("distinguishes a verified empty first page from an empty later page", async () => {
    let address = api;
    const page = {
      withPublishViewport: (run: () => Promise<void>) => run(),
      goto: vi.fn(),
      getUrl: () => dyUrl,
      inspectDocument: vi.fn(async () => "waiting"),
      observeJsonResponses: async (
        matches: (url: URL) => boolean,
        consume: (url: URL, data: unknown) => void,
        run: () => Promise<void>,
      ) => {
        if (matches(address))
          consume(address, { status_code: 0, comments: [], has_more: 0 });
        await run();
      },
    } as unknown as OpenCliPage;
    await expect(
      collectWorkComments(page, "douyin", dyUrl, new AbortController().signal),
    ).resolves.toMatchObject({ workId: id, items: [] });
    address = new URL(api.href.replace("cursor=0", "cursor=20"));
    await expect(
      collectWorkComments(page, "douyin", dyUrl, new AbortController().signal),
    ).rejects.toThrow("尚未读到");
  });
});
