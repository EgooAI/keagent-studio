import { app } from "electron";
import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import type { DouyinPublishInput } from "@keagent/shared-types";
import { PublishingError, type PublishFiles } from "../../core";
import type { LoginCheckResult } from "../../runtime/login/contracts";
import { channelsSelf } from "../checkLogin/channels";

interface ChromeJob {
  action: "login" | "check" | "publish" | "manage";
  profileDir: string;
  expectedAccountId?: string;
  input?: DouyinPublishInput;
  files?: PublishFiles;
}
interface ChromeEvents {
  opened?: () => void;
  beforeSubmit?: () => Promise<void>;
  verification?: (qr: string | undefined) => void;
  progress?: (value: number) => void;
}
const errors: Record<string, string> = {
  LOGIN_REQUIRED: "请在视频号助手窗口中扫码登录",
  ACCOUNT_MISMATCH: "当前视频号与已绑定账号不一致",
  ACCOUNT_CHANGED: "当前视频号与已绑定账号不一致",
  VERIFICATION_REQUIRED: "视频号实名扫码验证未完成",
  CHROME_NOT_FOUND: "未找到视频号浏览器，请修复或更新 AI来客",
  BROWSER_COMPONENT_UNAVAILABLE:
    "视频号专用浏览器文件不可用，请修复或更新 AI来客",
  BROWSER_PROFILE_NEWER: "当前视频号资料需要更新的浏览器，请更新 AI来客",
  BROWSER_START_FAILED: "视频号浏览器未能启动，请检查系统权限后重试",
  PROFILE_BUSY: "请关闭该账号正在使用的视频号窗口后重试",
  LOGIN_CLOSED: "视频号窗口已关闭",
};
export class ChannelsLoginExpired extends PublishingError {
  constructor() {
    super("LOGIN_REQUIRED", errors.LOGIN_REQUIRED);
  }
}

export async function runChannelsChrome(
  job: ChromeJob,
  signal: AbortSignal,
  events: ChromeEvents = {},
): Promise<LoginCheckResult | undefined> {
  signal.throwIfAborted();
  await mkdir(job.profileDir, { recursive: true, mode: 0o700 });
  const diagnostics = path.join(path.dirname(job.profileDir), "debug");
  await mkdir(diagnostics, { recursive: true, mode: 0o700 });
  const debugDir = await mkdtemp(path.join(diagnostics, "chrome-job-"));
  try {
    signal.throwIfAborted();
    const root = app.isPackaged
      ? process.resourcesPath
      : path.resolve(__dirname, "../../../../../output");
    const worker = spawn(
      path.join(
        root,
        "channels-runtime",
        process.platform === "win32"
          ? "channels-worker.exe"
          : "channels-worker",
      ),
      [],
      {
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      },
    );
    const exited = once(worker, "close").catch(() => {
      throw new PublishingError(
        "EXECUTION_FAILED",
        "视频号执行程序无法启动，请检查桌面安装包",
      );
    });
    void exited.catch(() => {});
    worker.stdin.on("error", () => {});
    let terminate: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (terminate) return;
      // EOF asks the worker to flush Chrome's profile and close its own browser.
      worker.stdin.end();
      terminate = setTimeout(() => worker.kill(), 8000);
      terminate.unref();
    };
    signal.addEventListener("abort", stop, { once: true });
    try {
      const lines = createInterface({ input: worker.stdout });
      worker.stdin.write(
        JSON.stringify({
          action: job.action,
          profileDir: job.profileDir,
          expectedAccountId: job.expectedAccountId,
          accountProbe: channelsSelf.toString(),
          debugDir,
          input: job.input,
          videoPath: job.files?.video,
          coverPath: job.files?.cover,
        }) + "\n",
      );
      let account: LoginCheckResult | undefined;
      let submitting = false;
      let accepted = false;
      for await (const line of lines) {
        signal.throwIfAborted();
        const event = JSON.parse(line);
        switch (event.event) {
          case "opened":
            events.opened?.();
            break;
          case "account":
            if (
              ![
                "logged_in",
                "logged_out",
                "expired",
                "unknown",
                "verification_required",
              ].includes(event.status)
            )
              throw new Error("视频号登录状态无效");
            if (
              event.status === "logged_in" &&
              (typeof event.id !== "string" ||
                !/^[\w.@-]{1,150}$/.test(event.id))
            )
              throw new PublishingError(
                "ACCOUNT_IDENTITY_UNAVAILABLE",
                "无法确认当前视频号身份",
              );
            if (
              job.expectedAccountId &&
              event.status === "logged_in" &&
              job.expectedAccountId !== event.id
            )
              throw new PublishingError(
                "ACCOUNT_CHANGED",
                errors.ACCOUNT_CHANGED,
              );
            account = {
              platform: "channels",
              status: event.status,
              accountId: event.id,
              nickname:
                typeof event.nickname === "string"
                  ? event.nickname.slice(0, 100)
                  : undefined,
              checkedAt: new Date().toISOString(),
              evidence: [],
            };
            break;
          case "verification":
            if (event.qrFile === "wechat_verification_qr.png")
              events.verification?.(path.join(debugDir, event.qrFile));
            break;
          case "verificationDone":
            events.verification?.(undefined);
            break;
          case "progress":
            if (Number.isFinite(event.value)) events.progress?.(event.value);
            break;
          case "beforeSubmit":
            if (!events.beforeSubmit || submitting)
              throw new Error("视频号提交确认无效");
            await events.beforeSubmit();
            signal.throwIfAborted();
            submitting = true;
            worker.stdin.write('{"ok":true}\n');
            break;
          case "accepted":
            accepted = submitting;
            break;
          case "error": {
            if (
              !submitting &&
              event.code === "LOGIN_REQUIRED" &&
              event.stage === "preflight"
            )
              throw new ChannelsLoginExpired();
            const code =
              typeof event.code === "string" &&
              Object.hasOwn(errors, event.code)
                ? event.code
                : "EXECUTION_FAILED";
            throw new PublishingError(
              code === "ACCOUNT_MISMATCH" ? "ACCOUNT_CHANGED" : code,
              errors[code] ?? "视频号助手未完成操作，请检查浏览器与账号状态",
            );
          }
        }
      }
      const [code] = await exited;
      signal.throwIfAborted();
      if (
        code !== 0 ||
        (job.action === "publish" && !accepted) ||
        ((job.action === "check" || job.action === "login") && !account)
      )
        throw new PublishingError("EXECUTION_FAILED", "视频号浏览器操作已中断");
      return account;
    } finally {
      signal.removeEventListener("abort", stop);
      stop();
      await exited.catch(() => {});
      clearTimeout(terminate);
      events.verification?.(undefined);
    }
  } finally {
    await rm(debugDir, { recursive: true, force: true, maxRetries: 5 });
  }
}
