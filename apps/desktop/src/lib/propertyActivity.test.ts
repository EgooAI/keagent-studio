import { expect, it } from "vitest";
import { propertyActivity } from "./propertyActivity";

it("排期、失败和人工核对使用各自的状态，同一成片跨平台只算一次", () => {
  const artifact = {
    id: "video",
    source: { producer: "panorama", taskId: "task", revision: 2 },
    content: { title: "", script: "", property: { id: "house", title: "" } },
  };
  const record = {
    artifactId: "video",
    state: "accepted" as const,
    scheduledAt: 12345,
  };
  const stats = (records: Parameters<typeof propertyActivity>[2]) =>
    propertyActivity([], [artifact], records).get("house");
  expect(stats([{ ...record, state: "failed" }])).toEqual({
    videos: 1,
    status: "unpublished",
  });
  expect(stats([record])).toEqual({ videos: 1, status: "scheduled" });
  expect(
    stats([
      { ...record, resultSource: "manual" },
      record,
      { ...record, state: "unknown" },
    ]),
  ).toEqual({ videos: 1, status: "published" });
});
