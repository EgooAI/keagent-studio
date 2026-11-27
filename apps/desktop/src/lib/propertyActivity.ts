import { artifactExchange, douyinApi } from "@keagent/api-client";
import type {
  DouyinPublishRecord,
  VideoArtifact,
  Workspace,
} from "@keagent/shared-types";
import { request } from "../components/panoramaClient";
import { productionResults } from "./productionResults";

type CompletedOutput = { taskId: string; revision: number; propertyId: string };
type Activity = {
  videos: number;
  status: "published" | "scheduled" | "unpublished";
};
export const emptyActivity: Activity = { videos: 0, status: "unpublished" };

export function propertyActivity(
  local: CompletedOutput[],
  artifacts: Pick<VideoArtifact, "id" | "content" | "source">[],
  records: Pick<
    DouyinPublishRecord,
    "state" | "artifactId" | "resultSource" | "scheduledAt"
  >[],
) {
  const stats = new Map<string, Activity>();
  const outputProperties = new Map<string, string>();
  const artifactProperties = new Map<string, string>();
  const key = (producer: string, taskId: string, revision: number) =>
    JSON.stringify([producer, taskId, revision]);
  for (const output of local)
    outputProperties.set(
      key("panorama", output.taskId, output.revision),
      output.propertyId,
    );
  for (const { id, content, source } of artifacts) {
    const version = key(source.producer, source.taskId, source.revision);
    const propertyId = content.property?.id ?? outputProperties.get(version);
    if (propertyId) {
      outputProperties.set(version, propertyId);
      artifactProperties.set(id, propertyId);
    }
  }
  for (const propertyId of outputProperties.values()) {
    const stat = stats.get(propertyId) ?? { ...emptyActivity };
    stat.videos++;
    stats.set(propertyId, stat);
  }
  for (const record of records) {
    if (record.state !== "accepted") continue;
    const propertyId = artifactProperties.get(record.artifactId);
    const stat = propertyId && stats.get(propertyId);
    if (stat && stat.status !== "published")
      stat.status =
        record.scheduledAt && record.resultSource !== "manual"
          ? "scheduled"
          : "published";
  }
  return stats;
}

export function demoPropertyActivity(workspace: Workspace) {
  const published = new Set(
    workspace.publishTasks
      .filter((task) => task.status === "published")
      .map((task) => task.productionTaskId),
  );
  const stats = new Map<string, Activity>();
  for (const task of workspace.tasks) {
    const stat = stats.get(task.propertyId) ?? { ...emptyActivity };
    stat.videos += productionResults(task).length;
    if (published.has(task.id)) stat.status = "published";
    stats.set(task.propertyId, stat);
  }
  return stats;
}

async function allPages<T>(
  fetchPage: (offset: number) => Promise<{ items: T[]; total: number }>,
) {
  const rows: T[] = [];
  while (true) {
    const { items, total } = await fetchPage(rows.length);
    rows.push(...items);
    if (rows.length >= total) return rows;
    if (!items.length) throw new Error("未能读取完整的房源统计");
  }
}

export async function loadPropertyActivity() {
  const [local, artifacts, records] = await Promise.all([
    window.desktop ? request<CompletedOutput[]>("completed-outputs") : [],
    allPages((offset) =>
      artifactExchange.listArtifacts({ offset, limit: 100 }),
    ),
    allPages((offset) => douyinApi.records("", offset, undefined, 100)),
  ]);
  return propertyActivity(local, artifacts, records);
}
