import { useState } from "react";
import {
  Film,
  FileCheck2,
  Send,
  MessageSquareHeart,
  CheckCircle2,
  Clock,
  ShieldCheck,
  Mic,
  Sparkles,
} from "lucide-react";

const TABS = [
  {
    id: "factory",
    label: "双模式批量出片",
    short: "短视频带看 / 经纪人开场",
    icon: Film,
  },
  {
    id: "review",
    label: "文案审核与音色复刻",
    short: "先审后制，音色可控",
    icon: FileCheck2,
  },
  {
    id: "publish",
    label: "双平台独立分发",
    short: "抖音与小红书独立核对",
    icon: Send,
  },
  {
    id: "leads",
    label: "评论监控与 AI 获客",
    short: "识别意向 + 人工跟进",
    icon: MessageSquareHeart,
  },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function CapabilityShowcase() {
  const [activeTab, setActiveTab] = useState<TabId>("factory");

  return (
    <div className="rounded-2xl border border-line bg-white">
      {/* Tab bar */}
      <div
        role="tablist"
        aria-label="核心能力展示"
        className="grid grid-cols-2 border-b border-line bg-soft/70 sm:grid-cols-4"
      >
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setActiveTab(tab.id)}
              className={`relative flex flex-col items-start gap-1 px-4 py-4 text-left transition-colors sm:px-5 ${
                active
                  ? "bg-white text-brand"
                  : "text-muted hover:bg-white/60 hover:text-ink-strong"
              }`}
            >
              <div className="flex items-center gap-2">
                <Icon className="h-4 w-4 shrink-0" />
                <span className="text-sm font-semibold">{tab.label}</span>
              </div>
              <span className="text-xs text-muted">{tab.short}</span>
              {active && (
                <span className="absolute right-0 bottom-0 left-0 h-0.5 bg-brand" />
              )}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <div className="p-6 sm:p-8">
        {activeTab === "factory" && (
          <div className="grid items-center gap-8 lg:grid-cols-12">
            <div className="space-y-4 lg:col-span-5">
              <div className="inline-flex items-center rounded-md bg-brand-soft px-2.5 py-1 text-xs font-medium text-brand">
                1 套配置 → N 条独立任务
              </div>
              <h3 className="text-xl font-bold text-ink-strong">
                VR 全景自动运镜，也支持真人实拍开场
              </h3>
              <p className="text-sm leading-relaxed text-muted">
                为每套房源导入 2–7 张原始 VR 全景图，系统按配音时长自动驱动平滑旋转镜头、句级字幕与封面合成。一次选择多套房源，每套生成独立任务与快照，单条失败不波及整批。
              </p>
              <ul className="space-y-2.5 pt-1 text-sm text-ink">
                <li className="flex items-start gap-2.5">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
                  <span>
                    <strong>短视频带看：</strong>直接由房源全景画面开场，适合高频批量铺量。
                  </span>
                </li>
                <li className="flex items-start gap-2.5">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
                  <span>
                    <strong>经纪人开场：</strong>从本机开场视频库选择 2–30 秒 MP4，保留经纪人实拍原声，再无缝衔接房源口播与全景镜头。
                  </span>
                </li>
                <li className="flex items-start gap-2.5">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
                  <span>
                    <strong>本机合成与缓存复用：</strong>调整镜头重试时自动复用已生成配音，不重复扣费。
                  </span>
                </li>
              </ul>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 lg:col-span-7">
              <div className="overflow-hidden rounded-xl border border-line bg-soft">
                <div className="relative h-44 overflow-hidden">
                  <img
                    src="/media/interior-4.jpg"
                    alt="纯房源全景带看示意"
                    className="h-full w-full object-cover"
                    loading="lazy"
                  />
                  <span className="absolute top-3 left-3 rounded-md bg-white/95 px-2.5 py-1 text-xs font-semibold text-ink-strong">
                    模式一：短视频带看
                  </span>
                </div>
                <div className="p-4">
                  <div className="text-sm font-semibold text-ink-strong">房源全景直接开场</div>
                  <p className="mt-1 text-xs leading-relaxed text-muted">
                    读取 2–7 张 VR 全景原图，按分场景口播自动匹配运镜节奏与醒目大标题封面。
                  </p>
                  <div className="mt-3 flex flex-wrap gap-1.5 text-[11px] text-muted">
                    <span className="rounded bg-white px-2 py-0.5 border border-line">自动运镜</span>
                    <span className="rounded bg-white px-2 py-0.5 border border-line">句级字幕</span>
                    <span className="rounded bg-white px-2 py-0.5 border border-line">批量并发</span>
                  </div>
                </div>
              </div>

              <div className="overflow-hidden rounded-xl border border-brand-border bg-brand-soft/35">
                <div className="relative h-44 overflow-hidden">
                  <img
                    src="/media/agent-tour.webp"
                    alt="经纪人实拍开场示意"
                    className="h-full w-full object-cover"
                    loading="lazy"
                  />
                  <span className="absolute top-3 left-3 rounded-md bg-brand px-2.5 py-1 text-xs font-semibold text-white">
                    模式二：经纪人开场
                  </span>
                </div>
                <div className="p-4">
                  <div className="text-sm font-semibold text-ink-strong">真人原声开场 + 房源全景</div>
                  <p className="mt-1 text-xs leading-relaxed text-muted">
                    开场片断保存在本机，完整保留真人原声与形象，口播配音从第一段房源画面自然切入。
                  </p>
                  <div className="mt-3 flex flex-wrap gap-1.5 text-[11px] text-brand">
                    <span className="rounded bg-white px-2 py-0.5 border border-brand-border">本机开场库</span>
                    <span className="rounded bg-white px-2 py-0.5 border border-brand-border">保留原声</span>
                    <span className="rounded bg-white px-2 py-0.5 border border-brand-border">免费拼接</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === "review" && (
          <div className="grid items-center gap-8 lg:grid-cols-12">
            <div className="space-y-4 lg:col-span-5">
              <div className="inline-flex items-center rounded-md bg-brand-soft px-2.5 py-1 text-xs font-medium text-brand">
                全链路可控 · 杜绝废片
              </div>
              <h3 className="text-xl font-bold text-ink-strong">
                先审文案再合成，支持本人音色复刻
              </h3>
              <p className="text-sm leading-relaxed text-muted">
                AI 结合房源参数与全景画面生成分段口播文案，任务先停留在「待审核」状态。确认文案准确无误后再进入语音合成与视频渲染，既保证房产信息准确合规，又避免无效积分消耗。
              </p>
              <ul className="space-y-2.5 pt-1 text-sm text-ink">
                <li className="flex items-start gap-2.5">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
                  <span>支持在线编辑文案、查看修订历史、随时重生成或取消单条任务。</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
                  <span>支持管理员上架的公共音色，也支持上传本人录音复刻专属音色并在线试听。</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
                  <span>修改已制作文案时自动生成新修订版本，旧成片留档不混淆。</span>
                </li>
              </ul>
            </div>

            <div className="rounded-xl border border-line bg-soft p-5 lg:col-span-7">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-3">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-brand" />
                  <span className="text-sm font-semibold text-ink-strong">口播文案审核面板（示意）</span>
                </div>
                <span className="rounded bg-amber-soft px-2 py-0.5 text-xs font-medium text-amber-ink">
                  待审核 · 修订 v2
                </span>
              </div>

              <div className="mt-4 space-y-3">
                <div className="rounded-lg border border-line bg-white p-3.5">
                  <div className="flex items-center justify-between text-xs text-muted">
                    <span>分镜 01 · 采光客厅全景</span>
                    <span>约 8.5 秒</span>
                  </div>
                  <p className="mt-1.5 text-sm leading-relaxed text-ink">
                    这套锦江澜岸东南边户三居，118平米格局方正。一进客厅就是超大落地观景窗，上午阳光直接洒满全屋，一家人日常活动非常敞亮。
                  </p>
                </div>

                <div className="rounded-lg border border-line bg-white p-3.5">
                  <div className="flex items-center justify-between text-xs text-muted">
                    <span>分镜 02 · 主卧套间全景</span>
                    <span>约 7.2 秒</span>
                  </div>
                  <p className="mt-1.5 text-sm leading-relaxed text-ink">
                    主卧自带飘窗与独立衣帽间，动静分区合理。小区步行可达地铁口，想看实地视频或了解户型细节，评论区留言即可。
                  </p>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-brand-border bg-brand-soft/45 px-3.5 py-2.5">
                  <div className="flex items-center gap-2 text-xs text-ink">
                    <Mic className="h-4 w-4 text-brand" />
                    <span>当前配音：</span>
                    <strong className="text-ink-strong">本人复刻音色 · 已就绪</strong>
                  </div>
                  <span className="rounded-md bg-brand px-3 py-1 text-xs font-medium text-white">
                    审核通过并开始合成
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === "publish" && (
          <div className="grid items-center gap-8 lg:grid-cols-12">
            <div className="space-y-4 lg:col-span-5">
              <div className="inline-flex items-center rounded-md bg-brand-soft px-2.5 py-1 text-xs font-medium text-brand">
                草稿与发布严格区分
              </div>
              <h3 className="text-xl font-bold text-ink-strong">
                一条成片，抖音与小红书独立配置分发
              </h3>
              <p className="text-sm leading-relaxed text-muted">
                发布中心保留每条成片的完整生产追溯信息（房源快照、文案修订、音色与模板版本）。同一成片可分别配置抖音与小红书的账号、标题、话题与封面，状态彼此独立。
              </p>
              <ul className="space-y-2.5 pt-1 text-sm text-ink">
                <li className="flex items-start gap-2.5">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
                  <span>支持预览验收后再提交，公开发布前明确二次确认。</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
                  <span>明确区分「平台草稿」「待核对」「正式发布成功」，绝不把未知状态当成功。</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
                  <span>遇到平台限制时自动提供本地待发布包，保障业务不中断。</span>
                </li>
              </ul>
            </div>

            <div className="space-y-3 rounded-xl border border-line bg-soft p-5 lg:col-span-7">
              <div className="text-xs font-semibold text-muted">同一成片的双平台独立发布任务（示意）</div>

              <div className="rounded-xl border border-line bg-white p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-slate-900 px-2 py-0.5 text-xs font-semibold text-white">
                      抖音
                    </span>
                    <span className="text-sm font-semibold text-ink-strong">
                      锦江澜岸118㎡三居全景带看 #实拍好房 #三室两厅
                    </span>
                  </div>
                  <span className="inline-flex items-center gap-1 rounded-md bg-success-soft px-2 py-0.5 text-xs font-medium text-success-ink">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    已核验正式发布
                  </span>
                </div>
                <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
                  <span>引用成果：修订 v2 · 经纪人开场版 · 00:34</span>
                  <span>房源已自动归入「已发布过」</span>
                </div>
              </div>

              <div className="rounded-xl border border-line bg-white p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-rose-600 px-2 py-0.5 text-xs font-semibold text-white">
                      小红书
                    </span>
                    <span className="text-sm font-semibold text-ink-strong">
                      阳光满屋的东南边户！这个客厅采光太治愈了
                    </span>
                  </div>
                  <span className="inline-flex items-center gap-1 rounded-md bg-amber-soft px-2 py-0.5 text-xs font-medium text-amber-ink">
                    <Clock className="h-3.5 w-3.5" />
                    平台草稿已保存（未公开）
                  </span>
                </div>
                <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
                  <span>差异化标题与封面 · 独立队列执行</span>
                  <span>不计入「正式发布」统计</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === "leads" && (
          <div className="grid items-center gap-8 lg:grid-cols-12">
            <div className="space-y-4 lg:col-span-5">
              <div className="inline-flex items-center rounded-md bg-brand-soft px-2.5 py-1 text-xs font-medium text-brand">
                只依原文证据 · 人工确认触达
              </div>
              <h3 className="text-xl font-bold text-ink-strong">
                双平台评论持续监控，AI 帮您筛选高意向购房客户
              </h3>
              <p className="text-sm leading-relaxed text-muted">
                复用本机已登录的抖音和小红书账号读取作品评论，支持桌面运行时每 15 分钟自动巡检。AI 仅根据评论原文提取购房意向、预算、区域和户型，不编造客户画像。
              </p>
              <ul className="space-y-2.5 pt-1 text-sm text-ink">
                <li className="flex items-start gap-2.5">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
                  <span>每条识别结果均附上引用的原始评论，未提及字段诚实标记“未识别”。</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
                  <span>AI 生成针对性跟进话术，支持在线编辑、关联房源并记录跟进状态。</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
                  <span>不做无差别陌生人群发骚扰，所有私信均经人工复核收件人后发送。</span>
                </li>
              </ul>
            </div>

            <div className="rounded-xl border border-line bg-soft p-5 lg:col-span-7">
              <div className="rounded-xl border border-line bg-white p-4">
                <div className="flex items-center justify-between text-xs text-muted">
                  <span>原始评论 · 抖音作品监控（每 15 分钟巡检）</span>
                  <span className="rounded bg-brand-soft px-2 py-0.5 font-semibold text-brand">
                    高意向线索
                  </span>
                </div>
                <blockquote className="mt-2.5 rounded-lg bg-canvas px-3.5 py-2.5 text-sm text-ink-strong">
                  “这套锦江澜岸还有高层吗？预算350到380万，想找个近地铁的三房，这周末能看房吗？”
                </blockquote>

                <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                  <div className="rounded-lg border border-line bg-soft p-2.5">
                    <div className="text-[11px] text-muted">预算区间</div>
                    <div className="mt-0.5 text-xs font-semibold text-price">350–380 万</div>
                  </div>
                  <div className="rounded-lg border border-line bg-soft p-2.5">
                    <div className="text-[11px] text-muted">意向户型</div>
                    <div className="mt-0.5 text-xs font-semibold text-ink-strong">三房</div>
                  </div>
                  <div className="rounded-lg border border-line bg-soft p-2.5">
                    <div className="text-[11px] text-muted">偏好条件</div>
                    <div className="mt-0.5 text-xs font-semibold text-ink-strong">高层 · 近地铁</div>
                  </div>
                  <div className="rounded-lg border border-line bg-soft p-2.5">
                    <div className="text-[11px] text-muted">看房时间</div>
                    <div className="mt-0.5 text-xs font-semibold text-ink-strong">本周末</div>
                  </div>
                </div>

                <div className="mt-4 rounded-lg border border-brand-border bg-brand-soft/35 p-3">
                  <div className="text-xs font-semibold text-brand">AI 建议跟进话术（可编辑后人工发送）</div>
                  <p className="mt-1 text-xs leading-relaxed text-ink">
                    您好！锦江澜岸目前有一套东南向高层三居在售，总价也在您 350–380 万预算内，步行可达地铁站。这周六或周日下午您几点方便，我提前帮您约好看房并把户型图发您参考？
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
