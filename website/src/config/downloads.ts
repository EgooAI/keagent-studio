/**
 * AI来客 桌面客户端下载配置
 *
 * 使用说明：
 * 1. 当某平台的 `url` 为空字符串 "" 时，下载页和首页会自动展示“安装包即将开放”的诚实状态，避免出现死链。
 * 2. 准备好 Windows / macOS 安装包直链（如对象存储 OSS、CDN 或 Release 地址）后，
 *    只需更新下方版本号与对应平台的 `url`、`size`、`sha256`，全站下载入口会自动同步。
 */

export type PlatformId = "win-x64" | "mac-arm64" | "mac-x64";

export interface PlatformPackage {
  id: PlatformId;
  name: string;
  archLabel: string;
  format: string;
  minOs: string;
  recommended?: boolean;
  filename: string;
  url: string;
  size: string;
  sha256: string;
  highlights: string[];
}

export interface ReleaseDownloadConfig {
  version: string;
  channel: string;
  releaseDate: string;
  summary: string;
  bundledRuntimeNotes: string[];
  packages: PlatformPackage[];
}

export const releaseDownloads: ReleaseDownloadConfig = {
  version: "0.1.1",
  channel: "内测版",
  releaseDate: "2026-11",
  summary:
    "开箱即用的桌面客户端，内置本机视频合成工具（FFmpeg / FFprobe）与内置浏览器运行环境，安装后无需额外配置开发环境。",
  bundledRuntimeNotes: [
    "无需自行安装 Node.js、Go、Python 或 FFmpeg",
    "本机视频渲染与开场拼接不消耗云端积分",
    "平台登录会话与本地素材缓存均按账号隔离保存在本机",
  ],
  packages: [
    {
      id: "win-x64",
      name: "Windows 桌面版",
      archLabel: "x64 安装包",
      format: ".exe (NSIS)",
      minOs: "Windows 10 / 11 (64 位)",
      recommended: true,
      filename: "AI-Laike-0.1.1-win-x64.exe",
      url: "",
      size: "",
      sha256: "",
      highlights: [
        "一键向导安装，支持桌面快捷方式与自动更新目录保留",
        "内置 FFmpeg / FFprobe 本机合成引擎",
        "支持抖音与小红书本机账号连接与评论监控",
      ],
    },
    {
      id: "mac-arm64",
      name: "macOS Apple Silicon",
      archLabel: "M1 / M2 / M3 / M4",
      format: ".dmg (arm64)",
      minOs: "macOS 12 Monterey 及以上",
      filename: "AI-Laike-0.1.1-mac-arm64.dmg",
      url: "",
      size: "",
      sha256: "",
      highlights: [
        "原生适配 Apple 芯片，本机全景运镜与视频编码更流畅",
        "拖入「应用程序」文件夹即可使用",
        "与 Windows 端同步云端房源、模板目录与积分账本",
      ],
    },
    {
      id: "mac-x64",
      name: "macOS Intel",
      archLabel: "Intel 处理器",
      format: ".dmg (x64)",
      minOs: "macOS 12 Monterey 及以上",
      filename: "AI-Laike-0.1.1-mac-x64.dmg",
      url: "",
      size: "",
      sha256: "",
      highlights: [
        "适配 Intel 架构 Mac 电脑",
        "完整包含本地媒体处理与发布队列能力",
        "适合老款门店办公 Mac 直接部署",
      ],
    },
  ],
};

export function hasAnyDownloadUrl(): boolean {
  return releaseDownloads.packages.some((pkg) => Boolean(pkg.url.trim()));
}
