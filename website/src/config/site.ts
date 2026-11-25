/**
 * AI来客 官网全局配置
 *
 * 所有可选品牌/联系信息默认留空，页面会自动隐藏未配置项；
 * 后续准备好域名、企业名称、备案号或联系方式后，直接在此处填写即可全站生效。
 */
export const siteConfig = {
  name: "AI来客",
  subtitle: "房产创作工作台",
  tagline: "面向房产经纪人与门店的 AI 批量带看视频与获客工作台",
  description:
    "AI来客帮助房产经纪人与门店批量导入房源资料，一键生成全景带看与经纪人实拍开场视频，审核文案并复刻本人音色，独立分发至抖音与小红书，并通过评论监控与 AI 线索分析高效获客。",

  // 以下字段按需填写；留空时页面不会展示任何占位文本
  domain: "",
  companyName: "",
  icpNumber: "",
  icpUrl: "https://beian.miit.gov.cn/",

  // 联系与商务通道（留空时自动隐藏对应入口）
  contact: {
    email: "",
    wechatId: "",
    wechatQrImage: "", // 例如 "/brand/wechat-qr.png"
    consultUrl: "", // 例如飞书/金数据预约表单链接
  },

  nav: [
    { label: "首页", href: "/" },
    { label: "下载中心", href: "/download" },
    { label: "使用帮助", href: "/docs" },
    { label: "更新日志", href: "/changelog" },
  ],
} as const;

export function hasContactConfigured(): boolean {
  const { email, wechatId, wechatQrImage, consultUrl } = siteConfig.contact;
  return Boolean(email || wechatId || wechatQrImage || consultUrl);
}
