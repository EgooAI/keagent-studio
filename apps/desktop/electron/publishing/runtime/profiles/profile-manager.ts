import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { session, type Session } from "electron";
import type { ProfileKey, ProxyOptions } from "../browser/contracts";
import {
  normalizeProfileKey,
  normalizeProxyOptions,
} from "../browser/browser-input";

export interface OpenedProfile {
  key: ProfileKey;
  saved: boolean;
  session: Session;
}

const ACCOUNT_SAVED_MARKER = ".account-saved";
const DELETE_PENDING_MARKER = ".delete-pending";

export class ProfileManager {
  constructor(
    private readonly profilesRoot: string,
    private readonly clearSession: (
      dataPath: string,
    ) => Promise<void> = clearProfileSession,
  ) {
    this.cleanupPendingDeletes();
  }

  isSaved(profile: ProfileKey): boolean {
    const key = normalizeProfileKey(profile);
    return (
      !this.isDeletePending(key) &&
      existsSync(path.join(this.accountPath(key), ACCOUNT_SAVED_MARKER))
    );
  }

  exists(profile: ProfileKey): boolean {
    const key = normalizeProfileKey(profile);
    return !this.isDeletePending(key) && existsSync(this.dataPath(key));
  }

  chromePath(profile: ProfileKey): string {
    return path.join(
      this.accountPath(normalizeProfileKey(profile)),
      "chrome-profile",
    );
  }

  private channelsBrowserPaths(profile: ProfileKey): string[] {
    const root = this.accountPath(normalizeProfileKey(profile));
    return ["chrome-profile", "chromium-profile"].map((folder) =>
      path.join(root, folder),
    );
  }

  hasChannelsBrowserState(profile: ProfileKey): boolean {
    return this.channelsBrowserPaths(profile).some((folder) =>
      existsSync(path.join(folder, "Local State")),
    );
  }

  async open(
    profile: ProfileKey,
    proxyOptions: ProxyOptions = {},
  ): Promise<OpenedProfile> {
    const key = normalizeProfileKey(profile);
    const dataPath = this.dataPath(key);
    mkdirSync(dataPath, { recursive: true });

    const profileSession = session.fromPath(dataPath);
    await this.applyProxyTo(profileSession, proxyOptions);
    profileSession.setPermissionCheckHandler(() => false);
    profileSession.setPermissionRequestHandler(
      (_webContents, _permission, callback) => callback(false),
    );

    return {
      key,
      saved: this.isSaved(key),
      session: profileSession,
    };
  }

  // 对已打开的 Profile 会话重设代理：登录与查看原文可能在同一会话上切换
  // 系统网络与账号固定代理，必须在显式打开时重新应用。
  async applyProxy(
    profile: ProfileKey,
    proxyOptions: ProxyOptions = {},
  ): Promise<void> {
    const key = normalizeProfileKey(profile);
    await this.applyProxyTo(session.fromPath(this.dataPath(key)), proxyOptions);
  }

  private applyProxyTo(
    profileSession: Session,
    proxyOptions: ProxyOptions,
  ): Promise<void> {
    const proxy = normalizeProxyOptions(proxyOptions);
    return profileSession
      .setProxy(
        proxy.proxyMode === "fixed_servers"
          ? { mode: proxy.proxyMode, proxyRules: proxy.proxyRules }
          : { mode: proxy.proxyMode },
      )
      .then(() => profileSession.closeAllConnections());
  }

  save(profile: ProfileKey): void {
    const accountPath = this.accountPath(normalizeProfileKey(profile));
    mkdirSync(accountPath, { recursive: true });
    // 只记录用户已确认保存，不把 Cookie、Token 或账号凭据复制到元数据文件。
    writeFileSync(path.join(accountPath, ACCOUNT_SAVED_MARKER), "", "utf8");
  }

  async delete(profile: ProfileKey): Promise<void> {
    const key = normalizeProfileKey(profile);
    const accountPath = this.accountPath(key);
    const dataPath = this.dataPath(key);
    // workspace/account 均已按单路径段校验；再次核对父目录，防止递归删除越界。
    const workspacePath = path.resolve(this.profilesRoot, key.workspaceId);
    if (path.dirname(accountPath) !== workspacePath) {
      throw new Error("Profile deletion target is outside its workspace");
    }
    if (existsSync(dataPath)) {
      // The retired embedded profile may remain locked while Chrome has already exited.
      for (const folder of this.channelsBrowserPaths(key)) {
        await rm(folder, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        });
      }
      await rm(path.join(accountPath, ACCOUNT_SAVED_MARKER), { force: true });
      await this.clearSession(dataPath);
      // Electron Session 与 Chromium 网络服务会在进程存活期间继续持有数据库文件；
      // Windows 下立即递归删除会因 EBUSY 失败。先隔离该 Profile，下次启动前清理。
      writeFileSync(path.join(accountPath, DELETE_PENDING_MARKER), "", "utf8");
      return;
    }
    await rm(accountPath, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }

  private cleanupPendingDeletes(): void {
    if (!existsSync(this.profilesRoot)) return;
    for (const workspace of readdirSync(this.profilesRoot, {
      withFileTypes: true,
    })) {
      if (!workspace.isDirectory()) continue;
      const workspacePath = path.join(this.profilesRoot, workspace.name);
      for (const account of readdirSync(workspacePath, {
        withFileTypes: true,
      })) {
        if (!account.isDirectory()) continue;
        const accountPath = path.join(workspacePath, account.name);
        if (!existsSync(path.join(accountPath, DELETE_PENDING_MARKER)))
          continue;
        try {
          rmSync(accountPath, {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 100,
          });
        } catch {
          // 清理失败不阻断启动；标记保留后会在下次启动继续重试。
        }
      }
    }
  }

  private isDeletePending(profile: ProfileKey): boolean {
    return existsSync(
      path.join(this.accountPath(profile), DELETE_PENDING_MARKER),
    );
  }

  private accountPath(profile: ProfileKey): string {
    return path.resolve(
      this.profilesRoot,
      profile.workspaceId,
      profile.accountId,
    );
  }

  private dataPath(profile: ProfileKey): string {
    return path.join(this.accountPath(profile), "chromium-data");
  }
}

async function clearProfileSession(dataPath: string): Promise<void> {
  const profileSession = session.fromPath(dataPath);
  await profileSession.closeAllConnections();
  await profileSession.clearStorageData();
  await profileSession.clearCache();
  await profileSession.clearAuthCache();
}
