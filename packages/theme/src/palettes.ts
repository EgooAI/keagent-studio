export const THEME_STORAGE_KEY = "keagent.appearance.color.v1";
export const palettes = [
  { id: "royal-purple", name: "皇冠紫", primary: "#722ed1" },
  { id: "blue", name: "经典蓝", primary: "#2563eb" },
  { id: "green", name: "松石绿", primary: "#087f6f" },
  { id: "rose", name: "玫瑰红", primary: "#b83264" },
] as const;
export type ThemePalette = { id: string; name: string; primary: string };

export function resolvePalette(
  value: string | null,
  defaultPalette: ThemePalette = palettes[0],
): ThemePalette {
  return palettes.find((palette) => palette.id === value) ?? defaultPalette;
}
