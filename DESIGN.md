---
name: KeAgent Studio
description: 白色工作面、冷灰背景与皇冠紫主操作组成的桌面工作界面。
colors:
  primary: "#722ed1"
  primary-hover: "#9254de"
  primary-active: "#531dab"
  selected-bg: "#f4eefb"
  selected-ink: "#722ed1"
  ink: "#1b2b44"
  muted: "#65738a"
  canvas: "#f6f8fb"
  surface: "#ffffff"
  line: "#e3e8f0"
  control-border: "#dee4ed"
  soft-surface: "#f7f9fc"
  segmented-bg: "#f1f4f9"
  tag-bg: "#f2f5f9"
  tag-ink: "#667990"
  focus: "#8e58da"
  price: "#aa4c2b"
  demo-bg: "#fff6e5"
  demo-ink: "#a66612"
  error-ink: "#b75243"
  admin-ink: "#111827"
  admin-muted: "#667085"
  admin-canvas: "#f7f8fa"
  admin-line: "#e7ebf0"
  admin-focus: "#8e58da"
typography:
  headline:
    fontFamily: '"Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "26px"
    fontWeight: 650
    lineHeight: 1.4
    letterSpacing: "-0.025em"
  title:
    fontFamily: '"Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "17px"
    fontWeight: 620
    lineHeight: 1.5
  body:
    fontFamily: '"Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5714285714285714
  label:
    fontFamily: '"Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "12px"
    fontWeight: 550
  secondary:
    fontFamily: '"Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.65
  admin-headline:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif'
    fontSize: "25px"
    fontWeight: 650
    letterSpacing: "-0.02em"
rounded:
  tag: "3px"
  badge: "4px"
  small: "6px"
  navigation: "7px"
  control: "8px"
  panel: "10px"
  modal: "12px"
spacing:
  tight: "4px"
  compact: "8px"
  action-gap: "10px"
  small: "12px"
  regular: "16px"
  form-gap: "18px"
  section: "20px"
  card-gap: "22px"
  panel: "24px"
  page: "32px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 15px"
    height: "38px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  button-primary-active:
    backgroundColor: "{colors.primary-active}"
  button-default:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 15px"
    height: "38px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    height: "38px"
  navigation:
    textColor: "#58667b"
    rounded: "{rounded.navigation}"
    padding: "13px 14px"
  navigation-active:
    backgroundColor: "{colors.selected-bg}"
    textColor: "{colors.selected-ink}"
  property-tag:
    backgroundColor: "{colors.tag-bg}"
    textColor: "{colors.tag-ink}"
    rounded: "{rounded.tag}"
    padding: "4px 6px"
  panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.panel}"
  property-selection:
    backgroundColor: "#fafcff"
    textColor: "#57749c"
    rounded: "{rounded.control}"
    padding: "16px"
---

# Design System: KeAgent Studio

## Overview

**Creative North Star: "清晰的工作台"**

白色工作面承载内容，冷灰背景分开工作区域，蓝色指出选择和下一步操作。系统中文字体、轻边框与紧凑但有留白的表单，让经纪人可以持续扫描房源、配置和任务状态。

界面的精确感来自一致的对齐、清楚的状态文字和真实房源照片。Electron 桌面与独立后台延续同一工作感；后台保留其已实现的中性色与字体回退栈。品牌表达服从操作，不增加装饰性渐变或无关展示。

**Key Characteristics:**

- 白色面板与冷灰页面形成清楚的区域层级。
- 蓝色同时用于主操作、当前导航与明确的选择状态。
- 系统中文字体配合紧凑标签，数字优先清楚对齐。
- 房源照片呈现内容，轻边框组织界面。

## Colors

单一蓝色主强调配合偏冷中性色；暖色承担价格、模拟提示和错误语义，不形成第二套品牌色。

### Primary

- **操作蓝**（`primary`）：主按钮、房源与资源选中边框、文字链接；悬停与按下沿用 Ant Design 主题从主色实际生成的两个变体。
- **选择浅蓝 / 选择蓝字**（`selected-bg` / `selected-ink`）：桌面当前导航，背景面积与文字同时表达当前位置。
- **焦点蓝**（`focus`）：键盘焦点轮廓；后台使用其现有 `admin-focus` 变体。

### Neutral

- **深蓝墨色**（`ink`）：桌面正文、标题和默认控件文字。
- **冷灰次要文字**（`muted`）：说明、元数据与页脚，共享同一变量，避免每处另定更浅的正文色。
- **冷灰画布 / 白色工作面**（`canvas` / `surface`）：页面背景与可操作内容区。
- **细线灰 / 控件边框灰**（`line` / `control-border`）：面板分区与标准表单控件。
- **柔灰工作面 / 分段灰底**（`soft-surface` / `segmented-bg`）：表头、审核设置和分段选择器的低层级底面。
- **标签灰底 / 标签灰字**（`tag-bg` / `tag-ink`）：房源特征标签，避免抢占主操作的蓝色。
- **后台墨色、次要灰、画布与分隔线**（`admin-ink`、`admin-muted`、`admin-canvas`、`admin-line`）：后台现有变体；不要把它们误写为桌面根变量。

### Semantic accents

- **陶土价格色**（`price`）：房源总价和价格摘要。
- **琥珀模拟提示**（`demo-ink` / `demo-bg`）：顶部模拟状态。
- **错误陶红**（`error-ink`）：发布记录的失败说明；通用警告、成功、校验和禁用状态继续采用 Ant Design 语义样式。

**The Shared Muted Rule.** 桌面次要文字优先复用 `muted`；对新增的小号文字，先检查实际背景上的对比度。

## Typography

**Display Font:** 系统字体栈；本系统没有独立展示字体。

**Body Font:** Segoe UI，回退 PingFang SC、Microsoft YaHei、sans-serif。后台首先采用 -apple-system 与 BlinkMacSystemFont，再回退 Segoe UI、Microsoft YaHei、sans-serif。

**Character:** 标题清楚而克制，正文与控件保持系统软件的阅读习惯。无装饰字形、全大写中文标签或独立等宽字体；价格和计数在已有场景使用等宽数字特性。

### Hierarchy

- **Headline**：页面标题使用 `headline`；窄窗口缩至（22px），后台采用 `admin-headline`。
- **Title**：区域标题使用 `title`；面板标题可收紧至（16px），小节标题采用（14px / 600 / 1.5）。
- **Body**：标准控件与正文使用 `body`；表格单元格为（12px），叙述文案按具体容器放宽行高。
- **Label**：表单标签使用 `label`，保留自然中文大小写与字距。
- **Secondary**：通用次要文字使用 `secondary`；密集元数据按已实现组件采用（10–11px），不用于主要操作说明。

## Layout

桌面外壳为固定侧栏（220px）、顶栏（68px）和可滚动主内容。主内容最大宽度（1880px），常规内边距为（32px 34px 0）；标题行将标题与操作分开，面板使用约（20–24px）内边距，常见内容网格间距为（22px）。这些是现有值，不是统一替换为单一倍数的要求。

房源与发布卡片默认三列，房源网格在（min-width: 1650px）变为四列。制作表单与预览使用双栏；预览面板距顶部（20px），最大高度为 `calc(100vh - 215px)` 并在面板内部滚动，底部提交操作保持可见。竖版预览使用（9:16），横版使用（16:9）。

桌面在（max-width: 1300px）收紧页边距与栏间距；（1080px）侧栏缩至（190px）、卡片两列、制作页单列；（760px）侧栏成为（65px）图标栏，内容网格单列、页边距收至（16px）。后台侧栏内容偏移为（222px），在（991px）收至（68px），在（700px）将表单改为单列、摘要改为两列。优先使用场景为（1440×900）与（1280×800）。

## Elevation & Depth

工作面默认平坦，通过白色、冷灰底色与细边框区分层级。桌面主按钮明确取消主色阴影。过滤选项的选中状态只有轻微抬升，房源与资源选择用一圈同色描边强化选中；弹窗、抽屉和控件反馈保留 Ant Design 的层级规则。

### Shadow Vocabulary

- **选中过滤项**（`0 1px 4px #1d334810`）：仅用于筛选分段中的白色选中项。
- **选择描边**（`0 0 0 1px #722ed1`）：房源和资源选择卡，承担状态轮廓而非投影。

**The Flat Work Surface Rule.** 普通工作面不添加悬浮大阴影；使用已存在的底色、边框和间距区分区域。

## Shapes

工作面使用柔和但紧凑的圆角。标准控件和选择卡采用 `control`，大面板与房源卡采用 `panel`，弹窗采用 `modal`。小标签与媒体状态用更小的 `tag`、`badge`；导航采用 `navigation`。照片和视频在所属容器内裁切，保持封面完整覆盖；圆形仅用于已有头像与播放控件。

## Components

### Buttons

主按钮为纯蓝底白字，桌面常规高度（38px），继承控件圆角，不带主色阴影；次按钮为白底、墨色文字和细灰边框。悬停与按下使用主题实际派生色，键盘焦点保留可见轮廓。标题区操作可折行，工厂主要操作位于预览摘要底部。

### Chips

房源特征标签采用灰底灰字与小圆角；模拟状态采用琥珀色文字和浅底。当前导航的数量标签跟随蓝色选择语义。任务状态继续用带文字的 Ant Design Tag，不单独依靠颜色表达状态。

### Cards / Containers

白底、细线和面板圆角构成共同边界。房源卡以真实照片作为顶部内容，正文与价格分列，元数据、特征标签和底部操作保持独立层次。选择卡在选中时加蓝色边框与同色描边；悬停时沿用现有边框提示，不添加位移。

### Inputs / Fields

标准 Ant Design 表单控件使用白底、控件边框、控件圆角及桌面常规高度，标签位于字段上方。复杂房源与模板选择采用弹窗，轻量资源选择沿用下拉。禁用、错误、焦点与弹窗交互继续使用组件库的已有状态；页面自定义交互保留可见键盘焦点。

### Navigation

桌面导航为图标与文字并列，默认冷灰，悬停淡灰，当前项浅蓝底和蓝字并提高字重。窄窗口改为图标栏；后台延续 Ant Design Menu 和已实现的折叠宽度。当前位置可同时由导航与面包屑辨认。

### Property selection summary

虚线边框的宽选择入口容纳房源缩略图叠放、已选数量与编辑入口。它把当前批量选择变成可检查的摘要；选中卡保留复选标识与房源资料，预览与批量数量保持同步。

### Motion

自定义导航背景、文字与卡片边框以（0.18s ease）过渡；标准控件保持 Ant Design 的主题过渡。动效用于状态反馈、弹窗与抽屉，不增加装饰循环。桌面尊重 `prefers-reduced-motion: reduce`，将动画与过渡时长缩至（0.01ms）并关闭平滑滚动。

## Do's and Don'ts

### Do:

- **Do** 用白色工作面、细边框和冷灰底色组织层级。
- **Do** 让蓝色表示主操作、当前位置和明确的选中状态。
- **Do** 复用系统字体与现有 Ant Design 控件，保留可见焦点和文字状态。
- **Do** 让真实房源照片和可辨认的元数据成为内容主体。
- **Do** 在紧凑窗口中保留工厂摘要与可触达的提交操作。

### Don't:

- **Don't** 给工作界面加入装饰性渐变、无关统计墙或大面积装饰阴影。
- **Don't** 把照片上用于保证文字可读的遮罩误用为页面装饰渐变。
- **Don't** 将所有状态都替换为主色，或只用颜色表达成功、失败和审核。
- **Don't** 为新增次要文字随意选取更浅的灰色。
- **Don't** 把桌面和后台的实际中性色差异当作尚未实现的统一主题。

默认配色为皇冠紫。桌面设置和后台系统设置可切换经典蓝、松石绿、玫瑰红，选择保存在当前来源的 localStorage（keagent.appearance.color.v1），不随账号同步。共享 ThemeProvider 同时更新 Ant Design 主色和 CSS accent 变量；成功、警告、错误语义色不参与替换。
