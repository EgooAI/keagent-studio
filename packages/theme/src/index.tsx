import {
  createContext,
  useContext,
  useLayoutEffect,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { App, ConfigProvider, Radio } from "antd";
import {
  palettes,
  resolvePalette,
  THEME_STORAGE_KEY,
  type ThemePalette,
} from "./palettes";
import "./theme.css";

const ThemeDefault = createContext<ThemePalette>(palettes[0]);
const listeners = new Set<() => void>();
function readPalette() {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    return null;
  }
}
function subscribe(listener: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === THEME_STORAGE_KEY || event.key === null) listener();
  };
  listeners.add(listener);
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}
function usePalette(defaultPalette: ThemePalette) {
  return resolvePalette(
    useSyncExternalStore(subscribe, readPalette, () => null),
    defaultPalette,
  );
}
function selectPalette(id: string) {
  // 存储失败时保留原主题，避免界面显示“已保存”却无法恢复。
  localStorage.setItem(THEME_STORAGE_KEY, id);
  listeners.forEach((listener) => listener());
}
export function ThemeProvider({
  children,
  defaultPalette = palettes[0],
}: {
  children: ReactNode;
  defaultPalette?: ThemePalette;
}) {
  const palette = usePalette(defaultPalette);
  useLayoutEffect(() => {
    document.documentElement.style.setProperty("--accent", palette.primary);
    document.documentElement.dataset.palette = palette.id;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", palette.primary);
  }, [palette]);
  return (
    <ThemeDefault.Provider value={defaultPalette}>
      <ConfigProvider
        theme={{
          token: { colorPrimary: palette.primary, colorInfo: palette.primary },
        }}
      >
        {children}
      </ConfigProvider>
    </ThemeDefault.Provider>
  );
}
export function ThemeSettings() {
  const defaultPalette = useContext(ThemeDefault);
  const palette = usePalette(defaultPalette);
  const choices = palettes.some((item) => item.id === defaultPalette.id)
    ? palettes
    : [defaultPalette, ...palettes];
  const { message } = App.useApp();
  return (
    <section className="theme-settings" aria-labelledby="theme-settings-title">
      <h2 id="theme-settings-title">主题设置</h2>
      <p>选择界面配色，立即应用到按钮、导航和选中状态。</p>
      <fieldset>
        <legend>界面配色</legend>
        <Radio.Group
          value={palette.id}
          onChange={(event) => {
            try {
              selectPalette(event.target.value);
            } catch {
              message.error("配色未保存，请检查本地存储权限后重试。");
            }
          }}
        >
          {choices.map((item) => (
            <Radio.Button key={item.id} value={item.id}>
              <span
                className="theme-swatch"
                style={{ backgroundColor: item.primary }}
                aria-hidden="true"
              />
              {item.name}
            </Radio.Button>
          ))}
        </Radio.Group>
      </fieldset>
      <p className="theme-settings-note">
        当前配色：{palette.name}。仅保存在当前应用与设备。
      </p>
    </section>
  );
}
