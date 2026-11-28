import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import manifest from "../../package.json" with { type: "json" };
const { version } = manifest;

test("检查更新前可读本版归档，检查后显示目标版本和更新内容", async ({
  page,
}) => {
  await page.addInitScript((version) => {
    let ready = false;
    Object.assign(window, {
      desktop: {
        updates: {
          request: async (action: string) => {
            if (action === "check") ready = true;
            return {
              version,
              phase: ready ? "ready" : "idle",
              nextVersion: ready ? "9.0.0" : undefined,
              releaseNotes: ready ? "测试新版的更新内容" : undefined,
            };
          },
          subscribe: () => () => {},
        },
      },
    });
  }, version);
  await page.goto("/#/settings/about");
  const notes = page.getByRole("region", { name: "版本更新内容" });
  await expect(notes).toContainText(`v${version} 更新内容`);
  await expect(notes.locator("p")).toHaveText(
    readFileSync(`docs/desktop-releases/${version}.md`, "utf8").trim(),
  );
  await page.getByRole("button", { name: "检查更新" }).click();
  await expect(notes).toContainText("v9.0.0 更新内容");
  await expect(notes.locator("p")).toHaveText("测试新版的更新内容");
  await expect(page.getByRole("button", { name: "重启并更新" })).toBeVisible();
});
