import { useState } from "react";
import { UserCheck, Building, Check, ArrowRight } from "lucide-react";

const ROLE_DATA = {
  agent: {
    badge: "适合一线房产经纪人",
    title: "一个人，也能稳定日更多套高质量带看视频",
    desc: "告别繁琐剪辑软件与零散工具。把房源资料和几张全景图放进桌面工作台，审完文案就能批量出片，还能保留你的真人开场与声音辨识度。",
    metrics: [
      { label: "一次批量配置", value: "N 套房源独立出片" },
      { label: "个人 IP 保留", value: "实拍原声 + 本人音色" },
      { label: "本机渲染成本", value: "0 积分消耗" },
    ],
    points: [
      "支持房源号批量录入、Excel/CSV 表格导入与人工补录，快速建立个人房源库",
      "一次勾选多套房源，自动为每套生成独立口播文案、配音、运镜视频与封面",
      "本机开场视频库随时复用，2–30 秒真人开场片断免费无缝拼接",
      "一个桌面客户端同时管理抖音与小红书发布任务、持续盯紧评论区高意向客户",
    ],
    primaryAction: { label: "前往下载桌面客户端", href: "/download" },
    secondaryAction: { label: "查看 5 分钟快速上手", href: "/docs/getting-started" },
  },
  store: {
    badge: "适合房产门店 / 区域运营团队",
    title: "独立 Web 管理后台，让整店内容生产标准化、可管控",
    desc: "经纪人在桌面端专注拍房、审稿与获客；门店管理员通过独立 Web 管理后台统一管理成员账号、设备、模板目录、AI 服务配置与积分预算。",
    metrics: [
      { label: "权限与数据隔离", value: "按账号独立归属" },
      { label: "素材资产分发", value: "云端目录一键下发" },
      { label: "预算与成本透明", value: "兑换码 + 流水可对账" },
    ],
    points: [
      "管理员统一创建与管理经纪人账号及绑定设备，不开放陌生人自助注册，保障门店资料安全",
      "在后台维护公共视频搭配、封面模板与公共音色，客户端自动检测版本并同步更新",
      "集中配置多模态文案与百炼语音等 AI 服务凭证，更换配置前自动用真实样例校验",
      "支持批量生成积分兑换码或后台手动充值，按账号精确记账，支持单机私有化/内测服务器部署",
    ],
    primaryAction: { label: "了解门店与后台管理", href: "/docs/store-admin" },
    secondaryAction: { label: "查看下载与部署要求", href: "/download" },
  },
} as const;

export default function RoleSolutions() {
  const [role, setRole] = useState<"agent" | "store">("agent");
  const current = ROLE_DATA[role];

  return (
    <div className="space-y-6">
      <div className="flex justify-center">
        <div
          role="tablist"
          aria-label="选择使用角色"
          className="inline-grid grid-cols-2 gap-1 rounded-xl border border-line bg-canvas p-1"
        >
          <button
            type="button"
            role="tab"
            aria-selected={role === "agent"}
            onClick={() => setRole("agent")}
            className={`inline-flex items-center justify-center gap-2 rounded-lg px-5 py-2.5 text-sm font-semibold transition-all ${
              role === "agent"
                ? "bg-white text-brand shadow-xs"
                : "text-muted hover:text-ink-strong"
            }`}
          >
            <UserCheck className="h-4 w-4" />
            <span>个人房产经纪人</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={role === "store"}
            onClick={() => setRole("store")}
            className={`inline-flex items-center justify-center gap-2 rounded-lg px-5 py-2.5 text-sm font-semibold transition-all ${
              role === "store"
                ? "bg-white text-brand shadow-xs"
                : "text-muted hover:text-ink-strong"
            }`}
          >
            <Building className="h-4 w-4" />
            <span>房产门店与运营团队</span>
          </button>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-line bg-white">
        <div className="grid lg:grid-cols-12">
          <div className="p-6 sm:p-8 lg:col-span-7">
            <span className="inline-flex rounded-md bg-brand-soft px-2.5 py-1 text-xs font-semibold text-brand">
              {current.badge}
            </span>
            <h3 className="mt-3 text-2xl font-bold tracking-tight text-ink-strong">
              {current.title}
            </h3>
            <p className="mt-3 text-sm leading-relaxed text-muted">{current.desc}</p>

            <ul className="mt-6 space-y-3">
              {current.points.map((point) => (
                <li key={point} className="flex items-start gap-2.5 text-sm text-ink">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand">
                    <Check className="h-3.5 w-3.5" strokeWidth={2.5} />
                  </span>
                  <span>{point}</span>
                </li>
              ))}
            </ul>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <a
                href={current.primaryAction.href}
                className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-brand-hover"
              >
                <span>{current.primaryAction.label}</span>
                <ArrowRight className="h-4 w-4" />
              </a>
              <a
                href={current.secondaryAction.href}
                className="inline-flex items-center gap-1.5 rounded-lg border border-control bg-white px-5 py-2.5 text-sm font-medium text-ink transition-colors hover:border-brand/50 hover:text-brand"
              >
                <span>{current.secondaryAction.label}</span>
              </a>
            </div>
          </div>

          <div className="flex flex-col justify-between border-t border-line bg-soft p-6 sm:p-8 lg:col-span-5 lg:border-t-0 lg:border-l">
            <div>
              <div className="text-xs font-semibold tracking-wider text-muted uppercase">
                关键价值要点
              </div>
              <div className="mt-4 space-y-3">
                {current.metrics.map((metric) => (
                  <div
                    key={metric.label}
                    className="rounded-xl border border-line bg-white p-4"
                  >
                    <div className="text-xs text-muted">{metric.label}</div>
                    <div className="mt-1 text-base font-bold text-ink-strong">
                      {metric.value}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-6 rounded-xl border border-line bg-white p-4 text-xs leading-relaxed text-muted">
              <strong className="text-ink-strong">工作流透明承诺：</strong>
              桌面端与管理后台分离设计，普通经纪人无需面对复杂运维配置，管理员也可随时掌控全店资产与使用状态。
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
