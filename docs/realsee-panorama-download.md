# 贝壳 / 如视 VR 全景下载脚本

脚本：`scripts/realsee-panorama.user.js`。不需要安装项目依赖，也不需要提供账号、Cookie 或 API Key。

## 使用

1. 在 Chrome / Edge 打开房源 VR 页面，等待加载完成。
2. 用记事本打开脚本，全选复制。
3. 按 F12，进入 Console（控制台），粘贴脚本并运行。页面右上方会出现下载面板。
4. 选择全部点位或一个点位，点击「生成 ZIP」。完成后点击「保存 ZIP」。

也可以将完整脚本添加到 Tampermonkey（油猴）并保存，刷新 VR 页面后自动出现面板。控制台方式刷新页面后需要重新运行。

## 下载内容

每个点位对应一个 `pano-001` 等目录，包含 `right`、`left`、`up`、`down`、`front`、`back` 六面源图，以及生成的 `panorama-4096x2048.jpg`。目录编号按本次选择的导出顺序排列；实际点位 ID 见 `manifest.json`。

源图保持页面提供的格式和分辨率（这个房源为 AVIF、2048×2048）。JPG 是六面源图转换得到的 2:1 等距柱状全景，输出 4096×2048；没有改变源图文件。`manifest.json` 记录来源、点位 ID、尺寸和失败信息。部分点位失败时，ZIP 仍会保留已下载文件，并在面板和清单中明确提示。

## 范围与限制

- 针对页面内嵌 `panorama.list` 的 Work 数据；支持如视页面用 HTML 注释包裹的 JSON。无需逐个点位走动。
- 下载页面实际给出的完整六面图，不替换 URL 猜测更高分辨率，也不处理需要另行授权、加密或只提供瓦片的数据。
- 单个 ZIP 内容上限 256 MiB，避免浏览器内存占用过大。超过时改用单点位下载。
- 点击取消会终止本轮；未保存的文件不会保留。点击「保存 ZIP」前保持页面打开。
- 原图已有的水印会保留；页面浮层（经纪人名片、按钮）不会出现在源图里。素材使用权以权利人的授权为准。

核查房源：`https://open.realsee.com/ke/6gyq3vmgjE8D7JO1/xqbYgM86e42cYh5haTrl3awSlLDZjkw0/#lianjia`。

Work 六面图字段参考：[如视 Work 数据结构](https://developer.realsee.ai/api-reference/schema-176753213)。

脚本自检：`node --test scripts/realsee-panorama.test.mjs`。
