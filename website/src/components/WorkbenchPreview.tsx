import { useState } from "react";
import {
  LayoutDashboard,
  Building2,
  Film,
  Send,
  MessageSquareText,
  Settings,
  Check,
  Mic,
  Sparkles,
  Volume2,
  Layers,
} from "lucide-react";

const PALETTES = [
  { id: "royal-purple", name: "皇冠紫", primary: "#722ed1", soft: "#f4eefb" },
  { id: "blue", name: "经典蓝", primary: "#2563eb", soft: "#eaf1ff" },
  { id: "green", name: "松石绿", primary: "#087f6f", soft: "#e6f5f3" },
  { id: "rose", name: "玫瑰红", primary: "#b83264", soft: "#fbeaf1" },
] as const;

const DEMO_PROPERTIES = [
  {
    id: "FJ-2048",
    name: "锦江澜岸 · 东南边户",
    meta: "3室2厅 · 118㎡ · 5张全景图",
    price: "368万",
    tag: "采光好",
    image: "/media/interior-1.jpg",
  },
  {
    id: "FJ-2051",
    name: "滨河壹号 · 精装大平层",
    meta: "4室2厅 · 142㎡ · 6张全景图",
    price: "520万",
    tag: "近地铁",
    image: "/media/interior-2.jpg",
  },
  {
    id: "FJ-2063",
    name: "云栖府 · 满五唯一",
    meta: "2室2厅 · 89㎡ · 4张全景图",
    price: "245万",
    tag: "拎包入住",
    image: "/media/interior-3.jpg",
  },
];

const NAV_ITEMS = [
  { label: "工作台", icon: LayoutDashboard, active: false },
  { label: "房源中心", icon: Building2, active: false },
  { label: "AI 视频工厂", icon: Film, active: true },
  { label: "发布中心", icon: Send, active: false },
  { label: "AI 获客", icon: MessageSquareText, active: false },
  { label: "设置", icon: Settings, active: false },
];

export default function WorkbenchPreview() {
  const [selectedIds, setSelectedIds] = useState<string[]>(["FJ-2048", "FJ-2051", "FJ-2063"]);
  const [mode, setMode] = useState<"property" | "agent">("agent");
  const [paletteIndex, setPaletteIndex] = useState(0);

  const palette = PALETTES[paletteIndex];

  function toggleProperty(id: string) {
    setSelectedIds((prev) => {
      if (prev.includes(id)) {
        return prev.length > 1 ? prev.filter((item) => item !== id) : prev;
      }
      return [...prev, id];
    });
  }

  const activeProperty =
    DEMO_PROPERTIES.find((p) => p.id === selectedIds[0]) ?? DEMO_PROPERTIES[0];

  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-white shadow-[0_18px_50px_-24px_rgba(15,23,42,0.18)]">
      {/* Desktop window titlebar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-soft px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-slate-300" />
          <span className="h-2.5 w-2.5 rounded-full bg-slate-300" />
          <span className="h-2.5 w-2.5 rounded-full bg-slate-300" />
          <span className="ml-2 text-xs font-medium text-ink">
            AI来客 · 房产创作工作台
          </span>
          <span className="rounded bg-amber-soft px-1.5 py-0.5 text-[11px] font-medium text-amber-ink">
            交互示意
          </span>
        </div>

        <div className="flex items-center gap-1.5" role="group" aria-label="切换桌面主题色">
          <span className="mr-1 hidden text-[11px] text-muted sm:inline">桌面配色</span>
          {PALETTES.map((p, idx) => (
            <button
              key={p.id}
              type="button"
              title={`切换主题：${p.name}`}
              aria-label={`切换主题：${p.name}`}
              aria-pressed={paletteIndex === idx}
              onClick={() => setPaletteIndex(idx)}
              className="flex h-5 w-5 items-center justify-center rounded-full border transition-transform hover:scale-110"
              style={{
                backgroundColor: p.primary,
                borderColor: paletteIndex === idx ? "#0f172a" : "transparent",
              }}
            >
              {paletteIndex === idx && <Check className="h-3 w-3 text-white" strokeWidth={3} />}
            </button>
          ))}
        </div>
      </div>

      {/* Desktop app body */}
      <div className="grid bg-canvas/70 md:grid-cols-[164px_minmax(0,1fr)]">
        {/* Left sidebar */}
        <div className="hidden border-r border-line bg-[#f0f2f5] p-3 md:flex md:flex-col md:justify-between">
          <div className="space-y-1">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              return (
                <div
                  key={item.label}
                  className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-xs font-medium transition-colors"
                  style={
                    item.active
                      ? { backgroundColor: palette.soft, color: palette.primary, fontWeight: 650 }
                      : { color: "#58667b" }
                  }
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  <span>{item.label}</span>
                </div>
              );
            })}
          </div>
          <div className="rounded-lg border border-line bg-white p-2.5 text-[11px] text-muted">
            <div className="font-medium text-ink">本机渲染引擎就绪</div>
            <div className="mt-0.5 text-[10px]">FFmpeg · 本机合成免费</div>
          </div>
        </div>

        {/* Main workspace content */}
        <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_218px]">
          {/* Configuration panel */}
          <div className="space-y-3.5 rounded-xl border border-line bg-white p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-sm font-semibold text-ink-strong">新建批量视频任务</div>
                <div className="text-xs text-muted">
                  点击勾选房源，查看多房源独立任务同步变化
                </div>
              </div>
              <span
                className="tabular-nums rounded-md px-2.5 py-1 text-xs font-semibold"
                style={{ backgroundColor: palette.soft, color: palette.primary }}
              >
                将创建 {selectedIds.length} 条独立任务
              </span>
            </div>

            {/* Mode selector */}
            <div className="grid grid-cols-2 gap-2 rounded-lg bg-canvas p-1">
              <button
                type="button"
                onClick={() => setMode("property")}
                aria-pressed={mode === "property"}
                className={`rounded-md px-3 py-1.5 text-left text-xs font-medium transition-all ${
                  mode === "property"
                    ? "bg-white text-ink-strong shadow-xs"
                    : "text-muted hover:text-ink"
                }`}
              >
                <div>短视频带看</div>
                <div className="text-[10px] font-normal text-muted">直接由房源全景开场</div>
              </button>
              <button
                type="button"
                onClick={() => setMode("agent")}
                aria-pressed={mode === "agent"}
                className={`rounded-md px-3 py-1.5 text-left text-xs font-medium transition-all ${
                  mode === "agent"
                    ? "bg-white text-ink-strong shadow-xs"
                    : "text-muted hover:text-ink"
                }`}
              >
                <div>经纪人开场</div>
                <div className="text-[10px] font-normal text-muted">实拍原声开场 + 房源全景</div>
              </button>
            </div>

            {/* Property multi-select cards */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-ink">已选房源（点击可切换）</span>
                <span className="text-muted">每套房源独立成片、互不影响</span>
              </div>
              <div className="grid gap-2 sm:grid-cols-3">
                {DEMO_PROPERTIES.map((prop) => {
                  const selected = selectedIds.includes(prop.id);
                  return (
                    <button
                      key={prop.id}
                      type="button"
                      onClick={() => toggleProperty(prop.id)}
                      aria-pressed={selected}
                      className="group overflow-hidden rounded-lg border bg-white text-left transition-colors"
                      style={
                        selected
                          ? {
                              borderColor: palette.primary,
                              boxShadow: `0 0 0 1px ${palette.primary}`,
                            }
                          : { borderColor: "#e1e5eb" }
                      }
                    >
                      <div className="relative h-20 w-full overflow-hidden bg-canvas">
                        <img
                          src={prop.image}
                          alt={prop.name}
                          className="h-full w-full object-cover"
                          loading="lazy"
                        />
                        <span
                          className="absolute top-1.5 right-1.5 flex h-5 w-5 items-center justify-center rounded-md border text-white transition-colors"
                          style={
                            selected
                              ? { backgroundColor: palette.primary, borderColor: palette.primary }
                              : { backgroundColor: "rgba(255,255,255,0.9)", borderColor: "#cbd5e1" }
                          }
                        >
                          {selected && <Check className="h-3 w-3" strokeWidth={3} />}
                        </span>
                      </div>
                      <div className="p-2">
                        <div className="flex items-baseline justify-between gap-1">
                          <span className="truncate text-xs font-semibold text-ink-strong">
                            {prop.name}
                          </span>
                        </div>
                        <div className="mt-0.5 flex items-center justify-between text-[11px]">
                          <span className="tabular-nums font-semibold text-price">{prop.price}</span>
                          <span className="rounded bg-soft px-1.5 py-0.5 text-[10px] text-muted">
                            {prop.tag}
                          </span>
                        </div>
                        <div className="mt-1 truncate text-[10px] text-muted">{prop.meta}</div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Config summary tags */}
            <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3 text-[11px] text-muted">
              <span className="inline-flex items-center gap-1 rounded-md bg-soft px-2 py-1">
                <Sparkles className="h-3 w-3" style={{ color: palette.primary }} />
                先审文案再合成
              </span>
              <span className="inline-flex items-center gap-1 rounded-md bg-soft px-2 py-1">
                <Mic className="h-3 w-3" style={{ color: palette.primary }} />
                本人复刻音色 / 公共音色
              </span>
              <span className="inline-flex items-center gap-1 rounded-md bg-soft px-2 py-1">
                <Layers className="h-3 w-3" style={{ color: palette.primary }} />
                {mode === "agent" ? "本机 MP4 原声拼接" : "VR 全景自动运镜"}
              </span>
            </div>
          </div>

          {/* Right vertical 9:16 preview panel */}
          <div className="flex flex-col justify-between rounded-xl border border-line bg-white p-3.5">
            <div>
              <div className="flex items-center justify-between text-xs font-medium text-ink">
                <span>9:16 竖屏示意</span>
                <span className="text-[11px] text-muted">
                  {mode === "agent" ? "开场 + 全景" : "纯房源"}
                </span>
              </div>

              <div className="relative mt-2.5 aspect-[9/14] w-full overflow-hidden rounded-xl border border-line bg-slate-900">
                <img
                  src={mode === "agent" ? "/media/agent-tour.webp" : activeProperty.image}
                  alt={mode === "agent" ? "经纪人开场预览示意" : "房源全景预览示意"}
                  className="h-full w-full object-cover"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-slate-950/85 via-slate-950/20 to-slate-950/45" />

                {/* Top cover headline */}
                <div className="absolute top-3 right-3 left-3">
                  <div className="inline-flex items-center gap-1 rounded bg-white/92 px-2 py-0.5 text-[10px] font-semibold text-ink-strong">
                    {mode === "agent" ? (
                      <>
                        <Volume2 className="h-3 w-3" style={{ color: palette.primary }} />
                        保留实拍原声
                      </>
                    ) : (
                      "醒目大标题封面"
                    )}
                  </div>
                  <div className="mt-1.5 text-sm leading-snug font-bold text-white drop-shadow-xs">
                    {activeProperty.name}
                  </div>
                </div>

                {/* Bottom subtitle overlay */}
                <div className="absolute right-3 bottom-3 left-3 space-y-1.5">
                  <div className="rounded-md bg-black/55 px-2.5 py-1.5 text-[11px] leading-snug text-white backdrop-blur-xs">
                    {mode === "agent"
                      ? "「大家好，今天带你看这套采光通透的三居室，进门先看客厅全景…」"
                      : "「南北通透大横厅，落地窗视野开阔，主卧带独立衣帽间…」"}
                  </div>
                  <div className="flex items-center justify-between text-[10px] text-slate-200">
                    <span>句级同步字幕</span>
                    <span>本机合成</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-3 border-t border-line pt-3">
              <div className="flex items-center justify-between text-[11px] text-muted">
                <span>本次批次</span>
                <span className="tabular-nums font-semibold text-ink-strong">
                  {selectedIds.length} 套房源 → {selectedIds.length} 条视频
                </span>
              </div>
              <div
                className="mt-2 flex h-8 w-full items-center justify-center rounded-lg text-xs font-medium text-white"
                style={{ backgroundColor: palette.primary }}
              >
                生成文案并进入审核（{selectedIds.length}）
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
