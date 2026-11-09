import { describe, expect, it } from "vitest";
import { palettes, resolvePalette } from "./palettes";
describe("appearance palettes", () => {
  it("defaults to royal purple and recovers unsupported stored values", () => {
    expect(resolvePalette(null).id).toBe("royal-purple");
    expect(resolvePalette("removed-theme").id).toBe("royal-purple");
    expect(resolvePalette("green").primary).toBe("#087f6f");
  });
  it("supports an app-specific fallback without replacing saved choices", () => {
    const fallback = { id: "mist-blue", name: "雾蓝", primary: "#3d607d" };
    expect(resolvePalette(null, fallback)).toBe(fallback);
    expect(resolvePalette(fallback.id, fallback)).toBe(fallback);
    expect(resolvePalette("blue", fallback).id).toBe("blue");
  });
  it("keeps white primary-button labels above AA contrast", () => {
    for (const palette of palettes) {
      const rgb = palette.primary
        .slice(1)
        .match(/../g)!
        .map((value) => {
          const s = parseInt(value, 16) / 255;
          return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        });
      const luminance = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
      expect(1.05 / (luminance + 0.05)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
