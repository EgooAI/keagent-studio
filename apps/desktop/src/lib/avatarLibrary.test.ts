import { expect, it } from "vitest";
import { validatePhotoFile } from "./avatarLibrary";
it("accepts only bounded JPEG and PNG photo uploads", () => {
  expect(() =>
    validatePhotoFile({ type: "image/jpeg", size: 1000 }),
  ).not.toThrow();
  for (const file of [
    { type: "image/svg+xml", size: 1000 },
    { type: "image/png", size: 0 },
    { type: "image/png", size: 5 * 1024 * 1024 + 1 },
  ])
    expect(() => validatePhotoFile(file)).toThrow();
});
