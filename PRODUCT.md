# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

React 工作界面运行在 Electron 桌面壳中，另提供独立管理后台。

## Stack

已确认 Electron、React、TypeScript、Vite、React Router、Ant Design、Tailwind CSS、Zustand、TanStack Query 与 Lucide。本轮仅实现前端与可持久化 Mock，不编写 Go 后端或本地媒体执行器。

## Users

房地产经纪人和门店运营人员在 Windows 或 macOS 桌面窗口中批量制作营销视频；管理员在独立 Web 界面维护资源和配置。

## Product Purpose

通过一套配置把多套房源制作成多个独立视频任务，审核文案，检查成果并分别提交平台草稿，同时辅助评论分析和线索跟进。

## Operating Context

六导航为工作台、房源中心、AI 视频工厂、发布中心、AI 获客和设置。用户一次选择多个房源，视频模式固定为纯口播和经纪人露脸；模板与资源按需选择。完整需求以 docs 中用户已确认的文档为准。

## Capabilities and Constraints

本轮全程明确模拟，不伪装平台、TTS 或数字人成功。房源和复杂模板使用弹窗，声音、形象和提示词使用下拉；开启审核时阻断下游。同一成片的不同平台任务独立；草稿不算已发布。首版不做收费、Redis、专业剪辑时间轴或独立内容资产页。

## Brand Commitments

KeAgent Studio 为工作名称。用户已批准文档约定的白色浅灰桌面操作界面、蓝色主操作、系统中文字体与清晰信息层级。产品名称不作为虚构商业承诺。

## Evidence on Hand

docs/01 至 docs/05 和共享对话是需求依据。界面房源、经纪人、任务和线索是明确标识的演示内容。没有真实外部服务接入凭证。

## Product Principles

- 多房源产生独立任务，配置简单而结果可追溯。
- 每一步可看到真实的当前状态与可执行操作。
- 审核和发布结果必须明确，未知不能当作成功。
- 演示数据可恢复，关键配置不因切换页面丢失。

## Accessibility & Inclusion

优先适配 1440×900 和 1280×800；所有表单有标签，弹窗管理焦点并支持 Escape，状态以文字和颜色共同表达。
