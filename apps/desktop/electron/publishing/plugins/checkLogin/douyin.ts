import type {
  PlatformLoginContext,
  PlatformLoginDetector,
} from "../../runtime/login/contracts";
import {
  ConfiguredPlatformLoginDetector,
  type PlatformLoginConfig,
} from "./configured-login-detector";

export const DOUYIN_LOGIN_CONFIG: PlatformLoginConfig = {
  platform: "douyin",
  homeUrl: "https://creator.douyin.com/",
  cookieUrls: ["https://creator.douyin.com/", "https://www.douyin.com/"],
  cookieNames: ["sessionid", "sessionid_ss", "sid_guard"],
  loggedOutUrls: [
    /^https:\/\/(?:sso|login)\.douyin\.com\//i,
    /^https:\/\/creator\.douyin\.com\/(?:passport|login)(?:\/|\?|$)/i,
  ],
  verificationUrls: [/(?:verify|verification|captcha|challenge|check_login)/i],
  riskUrls: [/(?:risk|account\/recovery|recovery_account|blocked)/i],
  dom: {
    loggedInSelectors: [
      "[class*='avatar'] img",
      "a[href*='/creator-micro/content']",
      "a[href*='/content/manage']",
      "a[href*='/content/upload']",
    ],
    loggedOutSelectors: [
      "input[placeholder*='手机号']",
      "input[placeholder*='验证码']",
      "img[src*='qrcode']",
      "canvas[class*='qr']",
    ],
    verificationSelectors: [
      "[class*='captcha']",
      "[class*='verify'] iframe",
      "input[placeholder*='短信验证码']",
    ],
    riskSelectors: ["[class*='risk']", "[class*='account-exception']"],
    loggedInTexts: ["内容管理", "发布作品", "创作中心"],
    loggedOutTexts: ["扫码登录", "手机号登录", "登录抖音"],
    verificationTexts: ["安全验证", "短信验证", "扫码确认", "拖动滑块"],
    riskTexts: ["账号异常", "访问频繁", "存在风险", "暂时无法登录"],
    localStorageKeys: ["creatorUserInfo", "user_info"],
    nicknameSelectors: [
      "[class*='user-info'] [class*='nickname']",
      "[class*='user-info'] [class*='name']",
      "[class*='account-info'] [class*='nickname']",
      "[class*='account-info'] [class*='name']",
    ],
    nicknameTextPatterns: [
      "(?:^|\\n)\\s*([^\\n|｜]{1,50}?)\\s*(?:\\||｜)\\s*抖音号\\s*[:：]",
    ],
  },
  accountApi: {
    url: "https://creator.douyin.com/aweme/v1/creator/user/info/",
    accountIdPaths: [
      ["douyin_user_verify_info", "douyin_unique_id"],
      ["user_profile", "unique_id"],
    ],
    nicknamePaths: [
      ["douyin_user_verify_info", "nick_name"],
      ["user_profile", "nick_name"],
    ],
    display: {
      avatarHosts: ["douyinpic.com"],
      avatarUrlPaths: [
        ["douyin_user_verify_info", "avatar_url"],
        ["user_profile", "avatar_url"],
      ],
      followersCountPaths: [
        ["douyin_user_verify_info", "follower_count"],
        ["user_profile", "follower_count"],
      ],
    },
    success: [{ path: ["status_code"], values: [0] }],
  },
};

export function createDouyinLoginDetector(
  context: PlatformLoginContext,
): PlatformLoginDetector {
  return new ConfiguredPlatformLoginDetector(DOUYIN_LOGIN_CONFIG, context);
}
