import type { ProductionTask } from "@keagent/shared-types";

export function productionResults(task: ProductionTask): ProductionTask[] {
  const results = new Map<number, ProductionTask>();
  for (const history of task.history ?? []) {
    if (history.videoUrl)
      results.set(history.revision, {
        ...task,
        productionRevision: history.revision,
        scriptRevision: history.scriptRevision ?? 0,
        script: history.script,
        videoUrl: history.videoUrl,
        coverUrl: history.coverUrl,
        status: "succeeded",
        progress: 100,
      });
  }
  if (task.status === "succeeded" && task.videoUrl)
    results.set(task.productionRevision, task);
  return [...results.values()].sort(
    (a, b) => b.productionRevision - a.productionRevision,
  );
}
