import { expect, it, vi } from "vitest";
import type { DouyinQueueRow } from "@keagent/shared-types";
import { DesktopOutreach } from "./outreach";

vi.mock("electron", () => ({ dialog: {}, nativeImage: {} }));

it.each(["platform", "manual", undefined] as const)(
  "syncs a previously uncertain cloud receipt with its local evidence (%s)",
  async (resultSource) => {
    const row: DouyinQueueRow = {
      id: "local",
      batchId: "batch",
      accountId: "account",
      title: "私信",
      kind: "message",
      state: resultSource ? "accepted" : "unknown",
      resultSource,
    };
    const report = vi.fn();
    const load = async (route: string, input?: unknown) => {
      if (route === "/v1/collection/outreach/result") return report(input);
      return {
        items: [
          {
            id: "cloud",
            attempt: 1,
            method: "electron",
            status: "uncertain",
            creatorhubTaskId: row.id,
          },
        ],
      };
    };
    const queue = {
      row: () => row,
      confirmMessage: vi.fn(),
      enqueueMessage: vi.fn(),
      control: vi.fn(),
    };
    const service = new DesktopOutreach(load, queue, async () => ({
      userId: "user",
      deviceId: "device",
      generation: 1,
    }));
    await service.refresh({ outreachId: "cloud", attempt: 1 });
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        creatorhubTaskId: row.id,
        confirmed: !!resultSource,
        status: resultSource ? "sent" : "uncertain",
      }),
    );
    expect(queue.confirmMessage).not.toHaveBeenCalled();
    expect(queue.enqueueMessage).not.toHaveBeenCalled();
  },
);

it.each(["unknown", "submitting"] as const)(
  "checks local %s state before manually resolving a stale cloud receipt",
  async (state) => {
    const local: DouyinQueueRow = {
      id: "local",
      batchId: "batch",
      accountId: "account",
      title: "私信",
      kind: "message",
      state,
    };
    let status = "sending";
    const reports: string[] = [];
    const load = async (route: string, input?: unknown) => {
      if (route.endsWith("/result")) {
        status = (input as { status: string }).status;
        reports.push(status);
        return {};
      }
      return {
        items: [
          {
            id: "cloud",
            attempt: 1,
            method: "electron",
            status,
            creatorhubTaskId: local.id,
          },
        ],
      };
    };
    const queue = {
      row: () => local,
      confirmMessage: vi.fn(() => {
        local.state = "failed";
        return local;
      }),
      enqueueMessage: vi.fn(),
      control: vi.fn(),
    };
    const service = new DesktopOutreach(load, queue, async () => ({
      userId: "user",
      deviceId: "device",
      generation: 1,
    }));
    const result = service.confirm({
      outreachId: "cloud",
      attempt: 1,
      status: "failed",
    });
    if (state === "unknown") {
      await expect(result).resolves.toMatchObject({ status: "failed" });
      expect(reports).toEqual(["uncertain", "failed"]);
      expect(queue.confirmMessage).toHaveBeenCalledOnce();
    } else {
      await expect(result).rejects.toMatchObject({ code: "OUTREACH_CHANGED" });
      expect(reports).toEqual([]);
      expect(queue.confirmMessage).not.toHaveBeenCalled();
    }
    expect(queue.enqueueMessage).not.toHaveBeenCalled();
  },
);

it.each(["sending", "uncertain", "failed"])(
  "retries only the cloud result after a local manual confirmation (%s)",
  async (initialStatus) => {
    const local: DouyinQueueRow = {
      id: "local",
      batchId: "local",
      accountId: "account",
      title: "私信",
      kind: "message",
      state: "failed",
      resultSource: "manual",
    };
    let status = initialStatus;
    const report = vi.fn((result: { status: string }) => {
      status = result.status;
    });
    const queue = {
      row: () => local,
      confirmMessage: vi.fn(),
      enqueueMessage: vi.fn(),
      control: vi.fn(),
    };
    const service = new DesktopOutreach(
      async (route, input) => {
        if (route.endsWith("/result"))
          return report(input as { status: string });
        return {
          items: [
            {
              id: "cloud",
              attempt: 1,
              method: "electron",
              status,
              creatorhubTaskId: local.id,
            },
          ],
        };
      },
      queue,
      async () => ({ userId: "user", deviceId: "device", generation: 1 }),
    );
    await expect(
      service.confirm({ outreachId: "cloud", attempt: 1, status: "failed" }),
    ).resolves.toMatchObject({ status: "failed" });
    if (initialStatus === "failed") expect(report).not.toHaveBeenCalled();
    else
      expect(report).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ status: "failed", confirmed: true }),
      );
    expect(queue.confirmMessage).not.toHaveBeenCalled();
    expect(queue.enqueueMessage).not.toHaveBeenCalled();
  },
);
