import type { BrowserView } from "../../runtime/browser/browser-view";
import type {
  LoginCheckResult,
  LoginStatus,
} from "../../runtime/login/contracts";

export const XHS_HOME = "https://www.xiaohongshu.com/explore";

// Read only the site's own navigation link. A feed author also has a profile
// link and a guest may have a web_session cookie.
export function xhsSelfLink() {
  if (location.origin !== "https://www.xiaohongshu.com")
    return { status: "unknown" };
  const visible = (element: Element) => element.getClientRects().length > 0;
  if (
    Array.from(
      document.querySelectorAll(
        'iframe[src*="captcha"], .captcha-container, [id*="captcha"]',
      ),
    ).some(visible) ||
    /\/(captcha|verify)(\/|$)/.test(location.pathname)
  )
    return { status: "verification_required" };
  if (
    Array.from(
      document.querySelectorAll(".login-container, .login-modal"),
    ).some(visible)
  )
    return { status: "logged_out" };
  const ids = new Set<string>();
  for (const link of document.querySelectorAll<HTMLAnchorElement>(
    ':is(aside,nav,[role="navigation"],.side-bar,.sidebar-container,.channel-list) a[href*="/user/profile/"]',
  )) {
    if (!visible(link) || link.innerText.trim() !== "我") continue;
    const url = new URL(link.href);
    const id = /^\/user\/profile\/([0-9a-f]{24})\/?$/i.exec(url.pathname)?.[1];
    if (url.origin === location.origin && id) ids.add(id);
  }
  return ids.size === 1
    ? { status: "logged_in", id: [...ids][0] }
    : { status: "unknown" };
}

export async function checkXhsLogin(
  view: BrowserView,
): Promise<LoginCheckResult> {
  const page = view.createOpenCliPage();
  await view.openOrReusePage(XHS_HOME);
  const cookies = await view.getCookies([XHS_HOME]);
  const hasSession = cookies.some(
    (c) =>
      c.name === "web_session" &&
      (c.expirationDate === undefined || c.expirationDate > Date.now() / 1000),
  );
  let result: { status: LoginStatus; id?: string } = { status: "unknown" };
  for (let attempt = 0; attempt < 8; attempt++) {
    result = await page.inspectDocument("(" + xhsSelfLink.toString() + ")()");
    if (result.status !== "unknown") break;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  const status =
    result.status === "logged_in" && !hasSession ? "logged_out" : result.status;
  return {
    platform: "xhs",
    status,
    accountId: status === "logged_in" ? result.id : undefined,
    checkedAt: new Date().toISOString(),
    evidence: [],
    errorMessage:
      status === "logged_in"
        ? undefined
        : "请在小红书首页完成登录或验证，确认侧栏显示「我」后再保存账号。",
  };
}
