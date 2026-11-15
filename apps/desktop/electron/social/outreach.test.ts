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
