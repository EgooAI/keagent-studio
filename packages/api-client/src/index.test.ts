import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProductionConfig } from "@keagent/shared-types";
import {
  advanceWorkspace,
  createInitialWorkspace,
  defaultConfig,
  demoApi,
  DEMO_STORAGE_KEY,
  isPropertyPublished,
} from "./index";

const config = (patch: Partial<ProductionConfig> = {}): ProductionConfig => ({
  ...structuredClone(defaultConfig),
  propertyIds: ["property-4", "property-5", "property-6"],
  ...patch,
});
const advance = (
  state: ReturnType<typeof createInitialWorkspace>,
  count = 40,
) => {
  for (let i = 0; i < count; i++) state = advanceWorkspace(state);
  return state;
};

beforeEach(async () => {
  vi.unstubAllGlobals();
  await demoApi.resetDemo();
});

describe("batch production", () => {
  it("creates one independent snapshot per selected property and reuses an idempotent request", async () => {
    const selection = config();
    const batch = await demoApi.createBatch(selection, "batch-one");
    const again = await demoApi.createBatch(selection, "batch-one");
    expect(again.id).toBe(batch.id);
    const state = await demoApi.getWorkspace();
    const tasks = state.tasks.filter((task) => task.batchId === batch.id);
    expect(tasks).toHaveLength(3);
    expect(new Set(tasks.map((task) => task.propertyId)).size).toBe(3);
    expect(state.batches.filter((item) => item.id === batch.id)).toHaveLength(
      1,
    );
    selection.videoMode = "avatar";
    await demoApi.updateProperty("property-4", {
      title: "Updated after creation",
    });
    expect(
      (await demoApi.getWorkspace()).tasks.find(
        (task) => task.batchId === batch.id && task.propertyId === "property-4",
      )?.propertySnapshot.title,
    ).not.toBe("Updated after creation");
    expect(tasks[0].configSnapshot.videoMode).toBe("voiceover");
    await expect(
      demoApi.createBatch(config({ requireScriptReview: false }), "batch-one"),
    ).rejects.toThrow("同一请求标识");
  });

  it("blocks downstream work until the current script is approved", async () => {
    const batch = await demoApi.createBatch(
      config({ propertyIds: ["property-4"] }),
      "review",
    );
    let state = advance(await demoApi.getWorkspace());
    let task = state.tasks.find((item) => item.id === batch.taskIds[0])!;
    expect(task.status).toBe("awaiting_review");
    expect(task.stage).toBe("script");
    expect(task.videoUrl).toBeUndefined();
    expect(advanceWorkspace(state)).toBe(state);
    for (let i = 0; i < 40; i++) await demoApi.tick();
    await demoApi.approveScript(
      task.id,
      "经过人工核验的新文案",
      task.scriptRevision,
    );
    state = advance(await demoApi.getWorkspace());
    task = state.tasks.find((item) => item.id === task.id)!;
    expect(task.status).toBe("succeeded");
    expect(task.approvedRevision).toBe(task.scriptRevision);
    expect(task.script).toBe("经过人工核验的新文案");
    expect(task.videoUrl).toBe("/media/demo-property.mp4");
  });

  it("validates duplicates, unavailable resources, missing media and avatar selection", async () => {
    await expect(
      demoApi.createBatch(
        config({ propertyIds: ["property-4", "property-4"] }),
        "duplicates",
      ),
    ).rejects.toThrow("重复");
    await expect(
      demoApi.createBatch(config({ propertyIds: ["property-8"] }), "media"),
    ).rejects.toThrow("素材");
    await expect(
      demoApi.createBatch(config({ videoMode: "avatar" }), "avatar"),
    ).rejects.toThrow("形象");
    await expect(
      demoApi.createBatch(
        config({ videoTemplate: { id: "video-3", version: "1.0.0" } }),
        "resource",
      ),
    ).rejects.toThrow("安装");
    await demoApi.downloadResource("video-3");
    for (let i = 0; i < 3; i++) await demoApi.tick();
    await expect(
      demoApi.createBatch(
        config({
          videoMode: "avatar",
          avatarId: "avatar-1",
          videoTemplate: { id: "video-3", version: "1.0.0" },
        }),
        "installed",
      ),
    ).resolves.toHaveProperty("taskIds");
  });

  it("invalidates current outputs after script edits while keeping the published revision", async () => {
    await demoApi.saveScript("task-1", "第二版口播文案", 1);
    const state = await demoApi.getWorkspace();
    const task = state.tasks.find((item) => item.id === "task-1")!;
    expect(task.videoUrl).toBeUndefined();
    expect(task.productionRevision).toBe(2);
    expect(task.status).toBe("awaiting_review");
    expect(task.history?.[0].revision).toBe(1);
    expect(task.history?.[0].videoUrl).toBe("/media/demo-property.mp4");
    expect(state.publishTasks[0].productionRevision).toBe(1);
    await expect(
      demoApi.createPublish(
        task.id,
        "xiaohongshu",
        {
          accountId: "account-xiaohongshu",
          title: "不可发布旧成果",
          description: "",
          hashtags: [],
        },
        "old",
      ),
    ).rejects.toThrow("等待视频");
  });

  it("retains the previous script when regenerating before a video exists", async () => {
    const previous = (await demoApi.getWorkspace()).tasks.find(
      (task) => task.id === "task-2",
    )!;
    expect(previous.status).toBe("awaiting_review");
    expect(previous.videoUrl).toBeUndefined();
    await demoApi.regenerateScript(previous.id, previous.scriptRevision);
    const current = (await demoApi.getWorkspace()).tasks.find(
      (task) => task.id === previous.id,
    )!;
    expect(current.script).toBe("");
    expect(current.history).toEqual([
      expect.objectContaining({
        revision: previous.productionRevision,
        scriptRevision: previous.scriptRevision,
        script: previous.script,
      }),
    ]);
    await demoApi.regenerateScript(previous.id, current.scriptRevision);
    expect(
      (await demoApi.getWorkspace()).tasks.find(
        (task) => task.id === previous.id,
      )?.history,
    ).toHaveLength(1);
  });

  it("does not revive a canceled task, and retry affects only the failed task", async () => {
    await demoApi.retryTask("task-3");
    let state = await demoApi.getWorkspace();
    expect(state.tasks.find((task) => task.id === "task-3")?.status).toBe(
      "queued",
    );
    expect(state.tasks.find((task) => task.id === "task-2")?.status).toBe(
      "awaiting_review",
    );
    await demoApi.cancelTask("task-3");
    await expect(demoApi.retryTask("task-3")).rejects.toThrow("只有失败");
    await expect(demoApi.saveScript("task-3", "新的文案", 1)).rejects.toThrow(
      "已取消",
    );
    state = advance(await demoApi.getWorkspace());
    expect(state.tasks.find((task) => task.id === "task-3")?.status).toBe(
      "canceled",
    );
  });

  it("rejects stale edits, approvals and regeneration without overwriting the newer script", async () => {
    const original = (await demoApi.getWorkspace()).tasks.find(
      (task) => task.id === "task-2",
    )!;
    const updated = await demoApi.saveScript(
      original.id,
      "另一窗口已保存的新文案",
      original.scriptRevision,
    );
    await expect(
      demoApi.saveScript(original.id, "旧窗口的编辑", original.scriptRevision),
    ).rejects.toMatchObject({ status: 409, code: "VERSION_CONFLICT" });
    await expect(
      demoApi.approveScript(
        original.id,
        original.script,
        original.scriptRevision,
      ),
    ).rejects.toMatchObject({ status: 409, code: "VERSION_CONFLICT" });
    await expect(
      demoApi.regenerateScript(original.id, original.scriptRevision),
    ).rejects.toMatchObject({ status: 409, code: "VERSION_CONFLICT" });
    expect(
      (await demoApi.getWorkspace()).tasks.find(
        (task) => task.id === original.id,
      )?.script,
    ).toBe(updated.script);
    await expect(
      demoApi.approveScript(
        original.id,
        updated.script,
        updated.scriptRevision,
      ),
    ).resolves.toHaveProperty("approvedRevision", updated.scriptRevision);
  });
});

describe("platform state and persistence", () => {
  it("keeps each platform independent, reconciles unknown results, and excludes drafts from published classification", async () => {
    const douyin = await demoApi.createPublish(
      "task-1",
      "douyin",
      {
        accountId: "account-douyin",
        title: "抖音标题",
        description: "",
        hashtags: [],
      },
      "douyin",
    );
    const red = await demoApi.createPublish(
      "task-1",
      "xiaohongshu",
      {
        accountId: "account-xiaohongshu",
        title: "小红书标题",
        description: "",
        hashtags: [],
        simulateFailure: true,
      },
      "red",
    );
    for (let i = 0; i < 5; i++) await demoApi.tick();
    let state = await demoApi.getWorkspace();
    expect(
      state.publishTasks.find((task) => task.id === douyin.id)?.status,
    ).toBe("draft_saved");
    expect(state.publishTasks.find((task) => task.id === red.id)?.status).toBe(
      "unknown",
    );
    await expect(
      demoApi.createPublish(
        "task-1",
        "xiaohongshu",
        {
          accountId: "account-xiaohongshu",
          title: "再发一次",
          description: "",
          hashtags: [],
        },
        "red-again",
      ),
    ).rejects.toThrow("待确认");
    await demoApi.reconcilePublish(red.id);
    state = await demoApi.getWorkspace();
    expect(state.publishTasks.find((task) => task.id === red.id)?.status).toBe(
      "draft_saved",
    );
    state.publishTasks = state.publishTasks.filter(
      (task) => task.id !== "publish-1",
    );
    expect(isPropertyPublished(state, "property-1")).toBe(false);
  });

  it("restores a saved draft and avoids notifications when the exact draft is saved again", async () => {
    const listener = vi.fn();
    const unsubscribe = demoApi.subscribe(listener);
    await demoApi.saveDraft(
      config({ videoMode: "avatar", avatarId: "avatar-1" }),
    );
    expect((await demoApi.getWorkspace()).draft.propertyIds).toHaveLength(3);
    expect((await demoApi.getWorkspace()).draft.videoMode).toBe("avatar");
    const calls = listener.mock.calls.length;
    await demoApi.saveDraft(
      config({ videoMode: "avatar", avatarId: "avatar-1" }),
    );
    expect(listener).toHaveBeenCalledTimes(calls);
    unsubscribe();
  });

  it("deduplicates import input, reports invalid rows and never calls a real provider", async () => {
    const result = await demoApi.importProperties([
      "",
      " ",
      "NEW12345",
      "NEW12345",
      "!bad",
    ]);
    expect(result.imported).toBe(1);
    expect(result.duplicates).toBe(1);
    expect(result.failed).toEqual(["!bad"]);
    expect(
      (await demoApi.getWorkspace()).properties.filter(
        (item) => item.propertyNumber === "NEW12345",
      ),
    ).toHaveLength(1);
    await expect(
      demoApi.importProperties(
        Array.from({ length: 501 }, (_, i) => `DEMO${i}`),
      ),
    ).rejects.toThrow("500");
    expect((await demoApi.getWorkspace()).properties).toHaveLength(9);
  });

  it("uses published cloud prompts without requiring a local package and freezes previously published resource content", async () => {
    const prompt = await demoApi.createResource({
      name: "云端提示词",
      type: "prompt",
      category: "口播",
      published: true,
    });
    expect(prompt.installed).toBe(false);
    await expect(
      demoApi.createBatch(
        config({ promptTemplate: { id: prompt.id, version: prompt.version } }),
        "cloud-prompt",
      ),
    ).resolves.toHaveProperty("taskIds");
    await demoApi.updateResource(prompt.id, { published: false });
    await expect(
      demoApi.updateResource(prompt.id, { name: "覆盖旧版本" }),
    ).rejects.toThrow("不可覆盖");
    const draft = await demoApi.createResource({
      name: "资源草稿",
      type: "cover",
      category: "演示",
    });
    await expect(
      demoApi.updateResource(draft.id, { name: "可编辑的草稿" }),
    ).resolves.toHaveProperty("name", "可编辑的草稿");
  });

  it("persists the first seed once and surfaces the first-write error without an in-memory fallback", async () => {
    const saved = new Map<string, string>();
    const localStorage = {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => {
        saved.set(key, value);
      },
    };
    vi.stubGlobal("window", {
      localStorage,
      isSecureContext: true,
      navigator: {
        locks: {
          request: async <T>(_name: string, operation: () => T) => operation(),
        },
      },
    });
    const first = await demoApi.getWorkspace();
    expect(saved.has(DEMO_STORAGE_KEY)).toBe(true);
    expect(await demoApi.getWorkspace()).toEqual(first);
    saved.delete(DEMO_STORAGE_KEY);
    localStorage.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    await expect(demoApi.getWorkspace()).rejects.toThrow("更改未保存");
    expect(saved.has(DEMO_STORAGE_KEY)).toBe(false);
  });

  it("refuses browser writes when secure Web Locks are unavailable", async () => {
    const setItem = vi.fn();
    vi.stubGlobal("window", {
      isSecureContext: true,
      navigator: {},
      localStorage: { getItem: () => null, setItem },
    });
    await expect(demoApi.saveDraft(config())).rejects.toThrow(
      "不支持安全的多窗口保存",
    );
    await expect(demoApi.resetDemo()).rejects.toThrow("不支持安全的多窗口保存");
    expect(setItem).not.toHaveBeenCalled();
  });

  it("rejects corrupt storage without deleting it, and does not commit failed writes", async () => {
    const saved = new Map<string, string>([[DEMO_STORAGE_KEY, "{broken"]]);
    const localStorage = {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => {
        saved.set(key, value);
      },
    };
    vi.stubGlobal("window", {
      localStorage,
      isSecureContext: true,
      navigator: {
        locks: {
          request: async <T>(_name: string, operation: () => T) => operation(),
        },
      },
    });
    await expect(demoApi.getWorkspace()).rejects.toThrow("原数据未清除");
    expect(saved.get(DEMO_STORAGE_KEY)).toBe("{broken");
    saved.set(DEMO_STORAGE_KEY, JSON.stringify(createInitialWorkspace()));
    localStorage.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    await expect(demoApi.saveDraft(config())).rejects.toThrow("更改未保存");
    expect(JSON.parse(saved.get(DEMO_STORAGE_KEY)!).draft.propertyIds).toEqual(
      [],
    );
  });
});
