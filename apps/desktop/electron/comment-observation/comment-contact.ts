import { PublishingError } from "../publishing/core";
import type { OpenCliPage } from "../publishing/runtime/browser/opencli-page";
import type { SocialPlatform } from "@keagent/shared-types";

/** Read the creator dashboard's own visible account marker in the isolated world. */
export async function confirmContactAccount(
  page: OpenCliPage,
  expected: string,
) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const result = await page.inspectDocument<{
      blocked: boolean;
      ids: string[];
    }>(
      String.raw`(() => {
        const text = document.body?.innerText || "";
        const creatorHome = location.origin === "https://creator.douyin.com" &&
          /^\/(?:creator-micro\/home\/?)?$/.test(location.pathname);
        const blocked = !creatorHome || /安全验证|拖动滑块|扫码登录|访问频繁|账号异常/.test(text);
        const ids = creatorHome
          ? [...new Set(Array.from(text.matchAll(/抖音号\s*[:：]\s*([A-Za-z0-9_.-]+)/g), match => match[1]))]
          : [];
        return { blocked, ids };
      })()`,
    );
    if (result.blocked)
      throw new PublishingError(
        "LOGIN_REQUIRED",
        "请先在账号浏览器完成登录或验证",
      );
    if (result.ids.length === 1 && result.ids[0] === expected) return;
    if (result.ids.length)
      throw new PublishingError(
        "ACCOUNT_CHANGED",
        "创作者中心显示的抖音号与已绑定账号无法匹配",
      );
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new PublishingError(
    "LOGIN_UNCONFIRMED",
    "创作者首页未显示可核对的抖音号",
  );
}

export function publicCommenterProfile(
  value: unknown,
  platform: SocialPlatform,
): string {
  const allowed =
    platform === "xhs"
      ? /^https:\/\/www\.xiaohongshu\.com\/user\/profile\/[0-9a-f]{24}\/?$/
      : /^https:\/\/www\.douyin\.com\/user\/[A-Za-z0-9_-]+\/?$/;
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    !allowed.test(value) ||
    value !== value.trim()
  ) {
    throw new PublishingError(
      "INVALID_CONTACT_PROFILE",
      "来源未提供当前平台的有效用户主页",
    );
  }
  return value.replace(/\/$/, "");
}
