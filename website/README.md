# AI来客 官方网站 (`website/`)

本目录为 **AI来客** 的独立产品介绍网站（Astro + React + Tailwind CSS v4），与仓库中的客户端、管理后台及后端功能代码完全隔离，不参与根目录的 workspace 依赖、类型检查、测试与 Electron 打包。

## 页面结构

- `/` — 产品首页（交互式桌面工作台预览、四步业务闭环、核心能力切换、个人经纪人 / 房产门店双方案、透明计费说明）
- `/download` — 桌面客户端下载中心（Windows x64 / macOS Apple Silicon / macOS Intel）
- `/docs` 与 `/docs/*` — 使用帮助中心（Markdown 驱动，自动生成侧边栏与页内目录）
- `/changelog` — 版本更新日志时间线（Markdown 驱动）

## 本地开发与构建

在仓库根目录执行（使用项目一致的 Corepack pnpm）：

```powershell
corepack pnpm --dir website install --ignore-workspace
corepack pnpm --dir website dev       # 本地预览 http://127.0.0.1:4321
corepack pnpm --dir website build     # 构建纯静态产物到 website/dist/
corepack pnpm --dir website preview   # 预览构建产物 http://127.0.0.1:4322
```

## 日常维护指南

### 1. 添加客户端下载链接

编辑 `website/src/config/downloads.ts`：

- 更新 `version`、`releaseDate` 与 `channel`；
- 在对应平台的 `packages` 项中填入 `url`（安装包直链）、`size`（文件大小）和 `sha256`（可选校验值）；
- 当 `url` 为空时，页面会自动显示“下载链接即将开放”的禁用态，不会出现 404 死链；填入后首页与下载页自动同步生效。

### 2. 补充品牌、备案或联系方式

编辑 `website/src/config/site.ts`：

- `companyName`、`domain`、`icpNumber` 以及 `contact` 下的 `email`、`wechatId`、`wechatQrImage`、`consultUrl` 默认留空；
- 留空时页面自动隐藏对应区域，后续准备好信息后填入即可自动展示。

### 3. 新增使用帮助文档

在 `website/src/content/docs/` 下新建 `.md` 文件，填写 Frontmatter：

```yaml
---
title: 文档标题
description: 一句话摘要
category: 核心功能 # 可选：快速上手 | 核心功能 | 账号与计费 | 门店与运维
order: 10
updatedAt: 2026-11
---
```

### 4. 发布新的更新日志

在 `website/src/content/changelog/` 下新建 `.md` 文件（例如 `v0-2-0.md`），提高 `order` 数值即可自动排在时间线最上方。

## 静态部署示例（Caddy）

构建产物为纯静态文件 `website/dist/`，可直接挂在现有 Caddy 服务器上：

```caddy
www.example.com {
	root * /opt/keagent/current/website/dist
	file_server
}
```
