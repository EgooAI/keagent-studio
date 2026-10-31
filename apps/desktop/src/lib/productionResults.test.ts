import { expect, it } from "vitest";
import { createInitialWorkspace } from "../../../../packages/api-client/src/fixtures";
import { productionResults } from "./productionResults";

it("新修订未完成时仍可访问旧成片，并分开显示各修订", () => {
  const task = createInitialWorkspace().tasks[0];
  const old = {
    revision: task.productionRevision,
    scriptRevision: task.scriptRevision,
    script: task.script,
    videoUrl: task.videoUrl,
    coverUrl: task.coverUrl,
  };
  task.history = [old];
  task.productionRevision = 2;
  task.status = "awaiting_review";
  delete task.videoUrl;
  expect(
    productionResults(task).map((result) => result.productionRevision),
  ).toEqual([1]);
  expect(productionResults(task)[0].script).toBe(old.script);
  task.status = "succeeded";
  task.videoUrl = "/media/new.mp4";
  expect(
    productionResults(task).map((result) => result.productionRevision),
  ).toEqual([2, 1]);
});
