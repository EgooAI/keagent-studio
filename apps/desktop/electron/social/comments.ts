import { setTimeout as pause } from "node:timers/promises";
import type { CommentDetail } from "@keagent/shared-types";
import { standardTarget } from "../comment-observation/target-validator";
import { PublishingError } from "../publishing/core";
import type { OpenCliPage } from "../publishing/runtime/browser/opencli-page";

export type SocialPlatform = "douyin" | "xhs";
export type WorkComment = Omit<
  CommentDetail,
  "id" | "firstSeenAt" | "lastSeenAt" | "updatedAt" | "comment_id"
> & { comment_id: string };

export function commentTarget(platform: SocialPlatform, input: string) {
  if (platform === "douyin") {
    const direct = URL.canParse(input) ? new URL(input) : null;
    const note = direct?.pathname.match(/^\/note\/(\d{5,30})\/?$/)?.[1];
    if (
      note &&
      direct &&
      direct.origin === "https://www.douyin.com" &&
      !direct.username &&
      !direct.password &&
      !direct.searchParams.has("modal_id")
    )
      return { workId: note, url: direct.origin + "/note/" + note };
    const target = standardTarget(input);
    return { workId: target.inputWorkId, url: target.targetUrl };
  }
  const url =
    typeof input === "string" && URL.canParse(input) ? new URL(input) : null;
  const workId = url?.pathname.match(
    /^\/(?:explore|discovery\/item|search_result)\/([a-f0-9]{24})\/?$/,
  )?.[1];
  if (
    platform !== "xhs" ||
    !url ||
    url.origin !== "https://www.xiaohongshu.com" ||
    url.username ||
    url.password ||
    !workId
  )
    throw new PublishingError(
      "INVALID_TARGET",
      "请在小红书打开具体笔记，再复制浏览器里的作品链接。",
      422,
    );
  const target = new URL("https://www.xiaohongshu.com/explore/" + workId);
  for (const name of ["xsec_token", "xsec_source"]) {
    const value = url.searchParams.get(name);
    if (value) target.searchParams.set(name, value);
  }
  return { workId, url: target.toString() };
}

/** Resolve a platform share link without forwarding the user's Electron session. */
export async function resolveCommentTarget(
  platform: SocialPlatform,
  input: string,
  signal?: AbortSignal,
) {
  const value = typeof input === "string" ? input.trim() : "";
  if (platform === "douyin" && /^\d{5,30}$/.test(value))
    return commentTarget(platform, "https://www.douyin.com/video/" + value);
  const link = value.match(/https?:\/\/[^\s<>"'，。；！、【】（）]+/i)?.[0];
  if (!link || !URL.canParse(link)) return commentTarget(platform, value);
  let url = new URL(link);
  const shortHost = platform === "douyin" ? "v.douyin.com" : "xhslink.com";
  const finalHost =
    platform === "douyin" ? "www.douyin.com" : "www.xiaohongshu.com";
  const timeout = AbortSignal.timeout(12000);
  for (let hop = 0; hop <= 4; hop++) {
    if (
      url.username ||
      url.password ||
      url.port ||
      !["http:", "https:"].includes(url.protocol)
    )
      break;
    url.protocol = "https:";
    if (
      platform === "douyin" &&
      ["www.iesdouyin.com", "www.douyin.com"].includes(url.hostname)
    ) {
      const share = url.pathname.match(
        /^\/share\/(video|note)\/(\d{5,30})\/?$/,
      );
      if (share)
        return commentTarget(
          platform,
          "https://www.douyin.com/" + share[1] + "/" + share[2],
        );
    }
    if (url.hostname === finalHost) return commentTarget(platform, url.href);
    if (
      url.hostname !== shortHost ||
      !/^\/(?:[A-Za-z0-9_-]+\/){0,3}[A-Za-z0-9_-]+\/?$/.test(url.pathname)
    )
      break;
    let next: string | null;
    try {
      const response = await fetch(url, {
        redirect: "manual",
        credentials: "omit",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      next =
        response.status >= 300 && response.status < 400
          ? response.headers.get("location")
          : null;
      await response.body?.cancel();
    } catch {
      signal?.throwIfAborted();
      break;
    }
    if (!next || !URL.canParse(next, url)) break;
    url = new URL(next, url);
  }
  throw new PublishingError(
    "INVALID_TARGET",
    "分享链接未能解析为当前平台的作品，请在平台打开并复制完整作品链接。",
    422,
  );
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown, maxLength: number) {
  if (typeof value !== "string") return null;
  const clean = value.replaceAll("\0", "");
  return clean.trim() ? Array.from(clean).slice(0, maxLength).join("") : null;
}

function count(value: unknown) {
  const number =
    typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof number === "number" &&
    Number.isSafeInteger(number) &&
    number >= 0
    ? number
    : null;
}

function normalize(
  platform: SocialPlatform,
  workId: string,
  value: unknown,
): WorkComment {
  const row = object(value);
  const dy = platform === "douyin";
  const relatedWork = dy ? row.aweme_id : (row.note_id ?? row.noteId);
  // Some Douyin responses serialize 19-digit work IDs numerically. The request
  // URL already scopes the page, so only compare losslessly represented IDs.
  if (typeof relatedWork === "string" && relatedWork !== workId)
    throw new PublishingError(
      "COMMENT_SOURCE_MISMATCH",
      "返回的评论属于其他作品",
    );
  const user = object(dy ? row.user : (row.user_info ?? row.userInfo));
  const id = dy ? row.cid : (row.id ?? row.commentId);
  if (typeof id !== "string" || !/^[\w-]{1,128}$/.test(id))
    throw new PublishingError(
      "COMMENT_FORMAT_CHANGED",
      "平台返回的评论缺少可核对的编号",
    );
  const uid = dy ? user.sec_uid : (user.user_id ?? user.userId);
  const body = dy ? row.text : row.content;
  const time = count(
    dy ? row.create_time : (row.create_time ?? row.createTime),
  );
  const millis = time && (time < 4102444800 ? time * 1000 : time);
  const profile = dy
    ? "https://www.douyin.com/user/"
    : "https://www.xiaohongshu.com/user/profile/";
  return {
    comment_id: id,
    parent_comment_id: null,
    comment_text: text(body, 8192),
    commenter_name: text(user.nickname, 256),
    commenter_profile:
      typeof uid === "string" &&
      (dy ? /^[\w-]{1,256}$/ : /^[0-9a-f]{24}$/i).test(uid)
        ? profile + uid
        : null,
    comment_time:
      millis && millis < 4102444800000 ? new Date(millis).toISOString() : null,
    like_count: count(dy ? row.digg_count : (row.like_count ?? row.likeCount)),
    reply_count: count(
      dy
        ? row.reply_comment_total
        : (row.sub_comment_count ?? row.subCommentCount),
    ),
    truncated:
      typeof body === "string" &&
      Array.from(body.replaceAll("\0", "")).length > 8192,
  };
}

function commentsWithReplies(
  platform: SocialPlatform,
  workId: string,
  values: unknown[],
) {
  const parents = values.map((row) => normalize(platform, workId, row));
  const replies: WorkComment[] = [];
  values.forEach((value, i) => {
    const row = object(value);
    const nested =
      platform === "douyin"
        ? row.reply_comment
        : (row.sub_comments ?? row.subComments);
    if (Array.isArray(nested)) {
      for (const child of nested)
        replies.push({
          ...normalize(platform, workId, child),
          parent_comment_id: parents[i].comment_id,
        });
    }
  });
  return parents.concat(replies);
}

export function matchesCommentPage(
  platform: SocialPlatform,
  workId: string,
  url: URL,
) {
  if (url.username || url.password) return false;
  if (platform === "douyin")
    return (
      url.origin === "https://www.douyin.com" &&
      url.pathname.replace(/\/$/, "") === "/aweme/v1/web/comment/list" &&
      url.searchParams.get("aweme_id") === workId
    );
  return (
    ["https://edith.xiaohongshu.com", "https://www.xiaohongshu.com"].includes(
      url.origin,
    ) &&
    url.pathname.replace(/\/$/, "") === "/api/sns/web/v2/comment/page" &&
    url.searchParams.get("note_id") === workId
  );
}

export function parseCommentPage(
  platform: SocialPlatform,
  workId: string,
  data: unknown,
) {
  const envelope = object(data);
  const dy = platform === "douyin";
  const page = dy ? envelope : object(envelope.data);
  if (
    (dy
      ? envelope.status_code !== 0
      : envelope.code !== 0 || envelope.success === false) ||
    !(
      Array.isArray(page.comments) ||
      (page.comments === null && page.has_more === 0 && dy)
    )
  )
    throw new PublishingError(
      "COMMENT_READ_FAILED",
      "平台未返回有效的评论列表，请在账号浏览器中核对作品和登录状态。",
    );
  return {
    items: commentsWithReplies(
      platform,
      workId,
      (page.comments || []) as unknown[],
    ),
    last: page.has_more === false || page.has_more === 0,
  };
}

// This runs in the isolated document world. Only interact with the work's
// comment toggle and the scroll container that encloses its comments.
function advanceComments(platform: SocialPlatform, openPanel: boolean) {
  const visible = (selector: string) =>
    Array.from(document.querySelectorAll<HTMLElement>(selector)).find(
      (el) => !!el.offsetWidth && !!el.offsetHeight,
    );
  const dy = platform === "douyin";
  if (
    visible(
      'iframe[src*="captcha"], iframe[src*="verify"], [data-e2e="verify-dialog"], .captcha-container, [data-e2e="login-modal"], .login-modal, [data-e2e="risk-control"]',
    )
  )
    return "restricted";
  const panel = visible(
    dy
      ? '[data-e2e="comment-item"], [data-e2e="comment-list"], [data-e2e="comment-panel"]'
      : ".comments-container, .comment-item, .comments-el",
  );
  if (
    panel &&
    visible(
      dy
        ? '[data-e2e="comment-empty"]'
        : ".comments-container .empty, .comments-container .no-comments",
    )
  )
    return "empty";
  if (!panel && openPanel && dy) {
    const toggle = visible(
      '[data-e2e="video-detail"] [data-e2e="feed-comment-icon"], [data-e2e="feed-active-video"] [data-e2e="feed-comment-icon"], [data-e2e="comment-toggle"][aria-expanded="false"]',
    );
    if (toggle) {
      toggle.click();
      return "opened";
    }
  }
  for (let el: HTMLElement | null = panel ?? null; el; el = el.parentElement) {
    if (
      /auto|scroll/.test(getComputedStyle(el).overflowY) &&
      el.scrollHeight > el.clientHeight + 10
    ) {
      el.scrollTop = el.scrollHeight;
      return "scroll";
    }
  }
  if (panel) panel.scrollIntoView({ block: "end" });
  return "waiting";
}

function inspectDouyinTitle(workId: string) {
  if (
    location.origin !== "https://www.douyin.com" ||
    location.pathname.match(/^\/(?:video|note)\/(\d+)\/?$/)?.[1] !== workId
  )
    return "";
  const detail = document.querySelector(
    '[data-e2e="video-detail"], [data-e2e="feed-active-video"]',
  );
  if (
    [
      detail?.getAttribute("data-aweme-id"),
      detail?.getAttribute("data-item-id"),
    ].some((id) => id && id !== workId)
  )
    return "";
  const heading = '[data-e2e="detail-video-title"], h1';
  const candidates = [
    detail?.querySelector(heading)?.textContent,
    document.querySelector(
      '[data-e2e="detail-video-info"] :is(' + heading + ")",
    )?.textContent,
    document
      .querySelector('meta[property="og:title"]')
      ?.getAttribute("content"),
    document.title,
    detail?.querySelector('[data-e2e="video-desc"]')?.textContent,
  ];
  for (const candidate of candidates) {
    const title = candidate
      ?.replace(/\s*[-–—|｜]\s*抖音\s*$/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (
      title &&
      title !== workId &&
      title !== `抖音作品 ${workId}` &&
      !/^(?:抖音作品|抖音(?:\s*[-–—|｜]\s*记录美好生活)?)$/.test(title)
    )
      return Array.from(title).slice(0, 200).join("");
  }
  return "";
}

export async function collectWorkComments(
  page: OpenCliPage,
  platform: SocialPlatform,
  input: string,
  signal: AbortSignal,
) {
  const { workId, url } = commentTarget(platform, input);
  const items = new Map<string, WorkComment>();
  let title = "";
  let confirmedEmpty = false;
  let last = false;
  const add = (rows: WorkComment[]) => {
    for (const row of rows) {
      if (items.size >= 500) break;
      items.set(row.comment_id, row);
    }
  };
  const assertWork = () => {
    if (commentTarget(platform, page.getUrl()).workId !== workId)
      throw new PublishingError(
        "COMMENT_SOURCE_MISMATCH",
        "页面已跳转到其他作品，请重新复制作品链接。",
      );
  };
  signal.throwIfAborted();
  try {
    await page.withPublishViewport(() =>
      page.observeJsonResponses(
        (address) => matchesCommentPage(platform, workId, address),
        (address, data) => {
          const parsed = parseCommentPage(platform, workId, data);
          add(parsed.items);
          last ||= parsed.last;
          const cursor = address.searchParams.get("cursor");
          if (
            parsed.last &&
            !parsed.items.length &&
            (!cursor || cursor === "0")
          )
            confirmedEmpty = true;
        },
        async () => {
          await page.goto(url);
          assertWork();
          if (platform === "xhs") {
            // XHS may render page one from SSR without making a comment request.
            const firstPage = await page.evaluate<unknown>(`(() => {
            const unwrap = value => value?._rawValue ?? value;
            const map = unwrap(window.__INITIAL_STATE__?.note?.noteDetailMap);
            const comments = unwrap(unwrap(map?.[${JSON.stringify(workId)}])?.comments);
            const list = comments?.list ?? comments?.comments ?? comments;
            return Array.isArray(list) ? list.slice(0,500) : [];
          })()`);
            if (Array.isArray(firstPage))
              add(commentsWithReplies(platform, workId, firstPage));
          }
          let idle = 0;
          let opened = false;
          for (let i = 0; i < 26 && items.size < 500; i++) {
            signal.throwIfAborted();
            assertWork();
            const before = items.size;
            const state = await page.inspectDocument<string>(
              `(${advanceComments.toString()})(${JSON.stringify(platform)}, ${!opened})`,
            );
            if (state === "restricted")
              throw new PublishingError(
                "ACCESS_RESTRICTED",
                "请在账号浏览器完成登录或平台验证后，再读取作品评论。",
              );
            if (state === "empty") confirmedEmpty = true;
            if (state === "opened") opened = true;
            if (last || confirmedEmpty) break;
            await pause(1000, undefined, { signal });
            idle = items.size === before ? idle + 1 : 0;
            if (idle >= (items.size ? 4 : 10)) break;
          }
          assertWork();
          if (platform === "douyin")
            title = await page
              .inspectDocument<string>(
                `(${inspectDouyinTitle.toString()})(${JSON.stringify(workId)})`,
              )
              .catch(() => "");
        },
      ),
    );
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof PublishingError) throw error;
    throw new PublishingError(
      "COMMENT_READ_FAILED",
      "未能读取作品评论，请在账号浏览器确认作品可见后重试。",
    );
  }
  signal.throwIfAborted();
  if (!items.size && !confirmedEmpty)
    throw new PublishingError(
      "COMMENT_READ_UNCONFIRMED",
      "尚未读到可核对的评论列表，请在账号浏览器检查作品链接、评论区和访问权限。",
    );
  return {
    workId,
    ...(title ? { title } : {}),
    items: [...items.values()],
    coverage: "partial" as const,
    observedAt: new Date().toISOString(),
  };
}
