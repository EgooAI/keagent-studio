import { expect, it } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const domain = require("./domain.cjs");

it("preserves legacy config shape and accepts explicit spatial camera mode", () => {
  expect(domain.config(domain.defaultConfig)).not.toHaveProperty("cameraMode");
  for (const cameraMode of ["panorama", "spatial"]) {
    expect(
      domain.config({ ...domain.defaultConfig, cameraMode }).cameraMode,
    ).toBe(cameraMode);
  }
  for (const cameraMode of ["unknown", null, 1]) {
    expect(() =>
      domain.config({ ...domain.defaultConfig, cameraMode }),
    ).toThrow("镜头模式无效");
  }
});
