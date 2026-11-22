# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

React 工作界面运行在 Electron 桌面壳中，另提供独立管理后台。

## Stack

已确认 Electron、React、TypeScript、Vite、React Router、Ant Design、Tailwind CSS、Zustand、TanStack Query 与 Lucide。实际制作使用 Go 云端服务和 Electron 本机媒体执行器。

## Users

房地产经纪人和门店运营人员在 Windows 或 macOS 桌面窗口中批量制作营销视频；管理员在独立 Web 界面维护资源和配置。

## Product Purpose

通过一套配置把多套房源制作成多个独立视频任务，审核文案，检查成果并分别提交平台草稿，同时辅助评论分析和线索跟进。

## Operating Context

六导航为工作台、房源中心、AI 视频工厂、发布中心、AI 获客和设置。用户一次选择多个房源，默认推荐「短视频带看」和「短视频带看 · 经纪人开场」，两者共用封面和文案。桌面端先读取本机目录缓存，再按云端版本同步。完整需求以 docs 中用户已确认的文档为准。

## Capabilities and Constraints

本机开场版需要手动选择 MP4，保留视频原声，口播文案和配音从房源画面开始。文案审核通过后继续制作。演示模式明确标识模拟结果。同一成片的不同平台任务独立，平台草稿与正式发布分别记录。

## Brand Commitments

KeAgent Studio 为工作名称。用户已批准文档约定的白色浅灰桌面操作界面、蓝色主操作、系统中文字体与清晰信息层级。产品名称不作为虚构商业承诺。

## Evidence on Hand

docs/01 至 docs/05 和共享对话是需求依据。演示环境中的房源、账号、任务和线索应明确标识为演示内容。

## Product Principles

- 多房源产生独立任务，配置简单而结果可追溯。
- 每一步可看到真实的当前状态与可执行操作。
- 审核和发布结果必须明确，未知不能当作成功。
- 演示数据可恢复，关键配置不因切换页面丢失。

## Accessibility & Inclusion

优先适配 1440×900 和 1280×800；所有表单有标签，弹窗管理焦点并支持 Escape，状态以文字和颜色共同表达。
