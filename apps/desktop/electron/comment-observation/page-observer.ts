import type {
  CommentObservation,
  CommentPanelStatus,
} from "@keagent/shared-types";
import type { OpenCliPage } from "../publishing/runtime/browser/opencli-page";

type Finding = Pick<
  CommentObservation,
  "panelStatus" | "verifiedWorkId" | "author" | "title" | "errorCode" | "reason"
>;

// Serialized into the document. Keep this function self-contained and read only named UI elements.
export function inspectWork(
  expected: string,
  hasViewerSession: boolean,
): Finding {
  const stop = (
    errorCode: string,
    reason: string,
    panelStatus: CommentPanelStatus = "not_checked",
  ) => ({ errorCode, reason, panelStatus });
  const visible = (element: Element) => {
    const rect = element.getBoundingClientRect();
    return (
      element.checkVisibility({
        checkOpacity: true,
        checkVisibilityCSS: true,
      }) &&
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < innerHeight &&
      rect.left < innerWidth
    );
  };
  const shown = (selector: string, root: ParentNode = document) =>
    Array.from(root.querySelectorAll(selector)).filter(visible);
  const locationKey = location.hostname + location.pathname;
  const notice = shown(
    '[role="dialog"] h2, [role="alert"] [role="heading"], [data-e2e="page-error-title"], [data-e2e="verify-title"]',
  ).map((el) => (el as HTMLElement).innerText.trim());
  if (
    /captcha|verify|verification|challenge/i.test(locationKey) ||
    notice.some((text) => /安全验证|拖动滑块|验证码/.test(text)) ||
    shown(
      '[class*="captcha"], iframe[src*="verify"], [id*="captcha"], [data-e2e="verify-dialog"]',
    ).length
  )
    return stop("VERIFICATION_REQUIRED", "页面要求完成安全验证", "restricted");
  if (
    /risk|blocked|recovery/i.test(locationKey) ||
    notice.some((text) =>
      /访问频繁|访问受限|无权查看|账号异常|暂无权限/.test(text),
    ) ||
    shown(
      '[data-e2e="risk-control"], [class*="risk-control"], [class*="account-exception"]',
    ).length
  )
    return stop("ACCESS_RESTRICTED", "平台限制访问此页面", "restricted");
  if (
    /^(sso|login)\.douyin\.com\/|\/(login|passport)(\/|$)/i.test(locationKey) ||
    shown(
      '[data-e2e="login-modal"], [data-e2e="top-login-button"], input[placeholder*="手机号"], img[src*="qrcode"]',
    ).length
  )
    return stop("LOGIN_REQUIRED", "抖音页面要求重新登录", "restricted");
  if (
    location.origin !== "https://www.douyin.com" ||
    !/^\/video\/(\d+)\/?$/.test(location.pathname)
  )
    return stop("TARGET_REDIRECT", "最终页面不是标准作品详情页");
  const path = "/video/" + expected;
  if (location.pathname.replace(/\/$/, "") !== path)
    return stop("TARGET_REDIRECT", "页面已跳转到其他作品");
  if (shown('[role="dialog"], [aria-modal="true"]').length)
    return stop("PAGE_BLOCKED", "页面被弹窗遮挡，无法继续核验", "restricted");
  if (
    !hasViewerSession &&
    !shown(
      ':is(header, [data-e2e="douyin-navigation"]) :is([data-e2e="user-info"], [data-e2e="user-avatar"])',
    ).length
  )
    return stop("LOGIN_UNCONFIRMED", "页面没有可确认当前登录状态的账号标记");

  const roots = shown(
    '[data-e2e="video-detail"], [data-e2e="feed-active-video"]',
  );
  if (roots.length !== 1)
    return stop("IDENTITY_UNCONFIRMED", "无法确定唯一的当前作品");
  const root = roots[0];
  const rect = root.getBoundingClientRect();
  const hit = document.elementFromPoint(
    (Math.max(0, rect.left) + Math.min(innerWidth, rect.right)) / 2,
    (Math.max(0, rect.top) + Math.min(innerHeight, rect.bottom)) / 2,
  );
  if (!hit || !root.contains(hit))
    return stop("PAGE_BLOCKED", "作品区域被其他界面遮挡，无法核验");
  const ids = [
    root.getAttribute("data-aweme-id"),
    root.getAttribute("data-item-id"),
  ].filter(Boolean);
  for (const link of shown('a[data-e2e="video-permalink"][href]', root)) {
    const url = new URL((link as HTMLAnchorElement).href);
    ids.push(
      url.origin === location.origin
        ? (url.pathname.match(/^\/video\/(\d+)\/?$/)?.[1] ?? "invalid")
        : "invalid",
    );
  }
  const canonical = document.querySelector<HTMLLinkElement>(
    'link[rel="canonical"]',
  );
  if (
    ids.some((id) => id !== expected) ||
    (canonical &&
      canonical.href.split(/[?#]/)[0].replace(/\/$/, "") !==
        location.origin + path)
  )
    return stop("WORK_MISMATCH", "当前作品标记与目标链接不一致");
  const pageTitle = document.title.replace(/\s*-\s*抖音$/, "").trim();
  const info = shown('[data-e2e="detail-video-info"]', root);
  const titleConfirmed =
    !!pageTitle &&
    info.length === 1 &&
    shown(
      'h1, [data-e2e="video-desc"], [data-e2e="detail-video-title"]',
      info[0],
    ).some((el) => (el as HTMLElement).innerText.trim() === pageTitle);
  if (!ids.length && !(canonical && titleConfirmed))
    return stop("IDENTITY_UNCONFIRMED", "作品详情缺少可独立核对的作品 ID");
  let authors = shown(
    'a[data-e2e="video-author-name"][href], [data-e2e="video-author-name"] a[href], a[data-e2e="detail-video-author"][href]',
    root,
  );
  if (!authors.length && titleConfirmed) {
    const profiles = shown(
      '[data-e2e="related-video"] [data-e2e="user-info"]',
      root,
    );
    if (profiles.length === 1) {
      const links = shown(
        'a[href*="/user/"]',
        profiles[0],
      ) as HTMLAnchorElement[];
      if (new Set(links.map((link) => link.origin + link.pathname)).size === 1)
        authors = links.filter((link) => link.innerText.trim());
    }
  }
  if (authors.length !== 1)
    return stop("AUTHOR_UNCONFIRMED", "无法确认作品作者");
  const authorUrl = new URL((authors[0] as HTMLAnchorElement).href);
  const name = (authors[0] as HTMLElement).innerText.trim().slice(0, 100);
  if (
    !name ||
    authorUrl.origin !== location.origin ||
    !/^\/user\/[\w-]+\/?$/.test(authorUrl.pathname)
  )
    return stop("AUTHOR_UNCONFIRMED", "作者资料链接或名称无法核验");
  const details = {
    verifiedWorkId: expected,
    title: titleConfirmed
      ? pageTitle.slice(0, 200)
      : (
          shown('[data-e2e="video-desc"]', root)[0] as HTMLElement | undefined
        )?.innerText
          .trim()
          .slice(0, 200),
    author: { name, url: authorUrl.origin + authorUrl.pathname },
  };
  const panels = Array.from(
    document.querySelectorAll(
      '[data-e2e="comment-list"], [data-e2e="comment-panel"]',
    ),
  );
  const ownedPanels = panels.filter((panel) => {
    const owner = panel.closest("[data-aweme-id], [data-item-id]");
    if (!owner) return root.contains(panel);
    return [
      owner.getAttribute("data-aweme-id"),
      owner.getAttribute("data-item-id"),
    ].every((id) => id === null || id === expected);
  });
  const panelsForWork = ownedPanels.filter(visible);
  const observe = (panelStatus: CommentPanelStatus, extra = {}) => ({
    ...details,
    panelStatus,
    ...extra,
  });
  if (
    !panelsForWork.length &&
    (ownedPanels.length ||
      shown(
        '[data-e2e="feed-comment-icon"][aria-expanded="false"], [data-e2e="comment-toggle"][aria-expanded="false"]',
        root,
      ).length)
  )
    return observe("not_visible");
  if (!panels.length)
    return observe("unknown", { reason: "无法识别评论面板或已收起的评论入口" });
  if (!panelsForWork.length)
    return observe("unknown", { reason: "可见评论面板与作品的归属无法确认" });
  const panel = panelsForWork.find(
    (p) => !panelsForWork.some((q) => q !== p && q.contains(p)),
  )!;
  if (!panelsForWork.every((p) => panel.contains(p)))
    return observe("unknown", { reason: "页面存在多个独立评论面板" });
  if (
    shown('[data-e2e="comment-restricted"], [data-e2e="comment-login"]', panel)
      .length
  )
    return observe("restricted", {
      errorCode: "COMMENT_RESTRICTED",
      reason: "平台限制查看评论区",
    });
  if (shown('[data-e2e="comment-load-error"]', panel).length)
    return observe("load_failed", {
      errorCode: "PANEL_LOAD_FAILED",
      reason: "评论区显示加载失败",
    });
  if (
    shown(
      '[aria-busy="true"], [role="progressbar"], [data-e2e="comment-loading"]',
      panel,
    ).length ||
    panel.getAttribute("aria-busy") === "true"
  )
    return observe("loading");
  const empty = shown('[data-e2e="comment-empty"]', panel).some((el) =>
    /^(暂无评论|还没有评论|暂无评论，抢沙发)$/.test(
      (el as HTMLElement).innerText.trim(),
    ),
  );
  const items = empty && shown('[data-e2e="comment-item"]', panel).length > 0;
  if (empty && !items) return observe("explicitly_empty");
  if (empty) return observe("unknown", { reason: "空态提示与页面显示冲突" });
  return observe("visible");
}

export function readWork(
  page: OpenCliPage,
  id: string,
  hasViewerSession: boolean,
) {
  return page.inspectDocument<Finding>(
    "(" +
      inspectWork.toString() +
      ")(" +
      JSON.stringify(id) +
      "," +
      hasViewerSession +
      ")",
  );
}

export async function observePage(
  page: OpenCliPage,
  id: string,
  signal: AbortSignal,
  hasViewerSession: boolean,
): Promise<Finding> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    const result = await readWork(page, id, hasViewerSession);
    signal.throwIfAborted();
    if (
      attempt >= 5 ||
      !(
        [
          "LOGIN_UNCONFIRMED",
          "IDENTITY_UNCONFIRMED",
          "AUTHOR_UNCONFIRMED",
        ].includes(result.errorCode ?? "") ||
        ["not_visible", "loading"].includes(result.panelStatus)
      )
    )
      return result;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}
