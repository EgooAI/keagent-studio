import DouyinAccounts from "../components/DouyinAccounts";
import { useEffect, useState } from "react";
import {
  Alert,
  Avatar,
  Button,
  Checkbox,
  Descriptions,
  Form,
  Grid,
  Input,
  Modal,
  Popconfirm,
  Radio,
  Select,
  Space,
  Switch,
  Tabs,
  Tag,
  Upload,
  message,
} from "antd";
import {
  Mic,
  Monitor,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UploadCloud,
  UserRound,
} from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import {
  authRequest,
  demoApi,
  isLive,
  type SessionUser,
} from "@keagent/api-client";
import { useQuery } from "@tanstack/react-query";
import { VoiceLibraryPanel } from "../components/VoiceLibrary";
import { FactoryPreferences } from "../components/FactoryPreferences";
import { ThemeSettings } from "@keagent/theme";
import type {
  AgentProfile,
  ProductionConfig,
  Resource,
  ResourceRef,
} from "@keagent/shared-types";
import { platformLabels } from "@keagent/shared-types";
import { PageHeader } from "../components/common";
import { useWorkspace } from "../lib/workspace";

function systemPreview() {
  if (!("speechSynthesis" in window)) {
    message.info("当前环境不支持系统语音试听");
    return;
  }
  window.speechSynthesis.cancel();
  const sample = new SpeechSynthesisUtterance(
    "你好，我是你的房产顾问。这套房源采光通透，期待和你一起发现理想的家。",
  );
  sample.lang = "zh-CN";
  window.speechSynthesis.speak(sample);
}

export default function SettingsPage() {
  const { section = "account" } = useParams();
  const navigate = useNavigate();
  const screens = Grid.useBreakpoint();
  const { data } = useWorkspace();
  const account = useQuery({
    queryKey: ["settings-account"],
    queryFn: () => authRequest<SessionUser>("session"),
    enabled: isLive && section === "account",
    retry: false,
  });
  const [profileForm] = Form.useForm<AgentProfile>();
  const [defaultsForm] = Form.useForm();
  const [creator, setCreator] = useState(false);
  const [assetName, setAssetName] = useState("");
  const [fileName, setFileName] = useState("");
  const [authorized, setAuthorized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const defaults = data?.profile.defaults;
  useEffect(() => {
    if (data && section === "profile") profileForm.setFieldsValue(data.profile);
  }, [data?.profile, profileForm, section]);
  useEffect(() => {
    if (defaults && !isLive && section === "defaults")
      defaultsForm.setFieldsValue({
        ...defaults,
        promptTemplate: defaults.promptTemplate.id,
        videoTemplate: defaults.videoTemplate.id,
        styleTemplate: defaults.styleTemplate.id,
        coverTemplate: defaults.coverTemplate.id,
      });
  }, [defaults, defaultsForm, section]);
  useEffect(() => () => window.speechSynthesis?.cancel(), []);
  if (!data) return null;
  async function act(action: () => Promise<unknown>, success?: string) {
    try {
      await action();
      if (success) message.success(success);
    } catch (error) {
      message.error(
        error instanceof Error ? error.message : "操作失败，请重试",
      );
    }
  }
  function openCreator() {
    setCreator(true);
    setAssetName("");
    setFileName("");
    setAuthorized(false);
  }
  async function createAsset() {
    if (!assetName.trim() || !fileName || !authorized) {
      message.warning("请填写名称、选择本人素材并确认授权");
      return;
    }
    setBusy(true);
    try {
      const voice = await demoApi.addVoice(assetName.trim());
      await demoApi.updateVoice(voice.id, {
        description: `模拟样本：${fileName}`,
      });
      setCreator(false);
      message.success("已创建模拟处理任务；素材不会上传");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "创建失败");
    } finally {
      setBusy(false);
    }
  }
  const voiceList = (
    <>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 12,
          alignItems: "center",
          marginBottom: 20,
        }}
      >
        <div>
          <h2 style={{ fontSize: 18, margin: "0 0 6px" }}>我的声音</h2>
          <span style={{ color: "#667085" }}>
            创建本人的专属音色，在视频中保持一致的表达。
          </span>
        </div>
        <Button
          type="primary"
          icon={<Plus size={15} />}
          onClick={() => openCreator()}
        >
          创建音色
        </Button>
      </div>
      <Alert
        type="info"
        title="音色创建为模拟处理；试听使用设备系统语音，不代表真实声音克隆效果。"
        style={{ marginBottom: 20 }}
      />
      {data.voices.map((voice) => (
        <div
          key={voice.id}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
            padding: "20px 0",
            borderBottom: "1px solid #edf0f4",
          }}
        >
          <Space size={15}>
            <Avatar
              style={{
                background: "var(--accent-soft)",
                color: "var(--accent)",
              }}
              size={44}
              icon={<Mic size={20} />}
            />
            <div>
              <strong>{voice.name}</strong>{" "}
              {voice.isDefault && <Tag color="blue">默认</Tag>}
              <p style={{ color: "#667085", margin: "5px 0 0" }}>
                {voice.status === "processing"
                  ? "模拟处理中…"
                  : voice.description}
              </p>
            </div>
          </Space>
          <Space wrap>
            <Button
              size="small"
              icon={<Play size={13} />}
              disabled={voice.status !== "ready"}
              onClick={systemPreview}
            >
              试听
            </Button>
            <Button
              size="small"
              onClick={() => setRenaming({ id: voice.id, name: voice.name })}
            >
              重命名
            </Button>
            {!voice.isDefault && (
              <Button
                size="small"
                disabled={voice.status !== "ready"}
                onClick={() =>
                  void act(
                    () => demoApi.updateVoice(voice.id, { isDefault: true }),
                    "已设为默认音色",
                  )
                }
              >
                设为默认
              </Button>
            )}
            <Popconfirm
              title="删除这个音色？"
              description="正在使用的音色将受到引用保护。"
              onConfirm={() =>
                act(() => demoApi.removeVoice(voice.id), "音色已删除")
              }
              okText="删除"
              cancelText="取消"
            >
              <Button
                size="small"
                danger
                aria-label={`删除${voice.name}`}
                icon={<Trash2 size={14} />}
              />
            </Popconfirm>
          </Space>
        </div>
      ))}
    </>
  );
  const accountSettings = (
    <>
      <h2 style={{ fontSize: 18, marginTop: 0 }}>账号信息</h2>
      <Space size={20} style={{ margin: "12px 0 28px" }}>
        <Avatar
          size={64}
          style={{
            background: "var(--accent-soft)",
            color: "var(--accent)",
            fontSize: 25,
          }}
        >
          {data.profile.name.slice(-2)}
        </Avatar>
        <div>
          <strong style={{ fontSize: 18 }}>{data.profile.name}</strong>
          <p style={{ margin: "8px 0 0", color: "#667085" }}>
            {isLive ? (
              <>
                {account.data?.email || "正在读取账号"}{" "}
                <Tag color="green">已登录</Tag>
              </>
            ) : (
              <>
                个人演示工作区 <Tag>Mock</Tag>
              </>
            )}
          </p>
        </div>
      </Space>
      <Descriptions
        column={1}
        items={[
          {
            key: "type",
            label: "账号类型",
            children: isLive
              ? account.data
                ? account.data.role === "admin"
                  ? "管理员账号"
                  : "用户账号"
                : "待读取"
              : "前端演示账号",
          },
          {
            key: "scope",
            label: "数据范围",
            children: isLive
              ? "当前登录账号的云端工作区与本机制作数据"
              : "仅保存在当前浏览器或桌面应用的数据目录中",
          },
          {
            key: "auth",
            label: "认证状态",
            children: isLive
              ? account.isError
                ? "身份读取失败，请刷新或重新登录"
                : "由认证服务验证登录，密钥和登录凭据不会在设置页展示"
              : "未接入真实认证服务，不存储真实登录凭据",
          },
        ]}
      />
      {!isLive && (
        <Alert
          type="info"
          showIcon
          title="当前无需真实账号即可体验全部前端流程。正式注册、登录和权限将在后续接入后端时实现。"
          style={{ marginTop: 20 }}
        />
      )}
    </>
  );
  const profileSettings = (
    <>
      <h2 style={{ fontSize: 18, marginTop: 0 }}>经纪人资料</h2>
      <p style={{ color: "#667085", marginBottom: 24 }}>
        这些信息可用于房源文案和视频署名。
      </p>
      <Form
        form={profileForm}
        layout="vertical"
        style={{ maxWidth: 640 }}
        onFinish={(values) =>
          void act(() => demoApi.updateProfile(values), "经纪人资料已保存")
        }
      >
        <div
          style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}
        >
          <Form.Item
            name="name"
            label="经纪人姓名"
            rules={[{ required: true, message: "请输入姓名" }, { max: 30 }]}
          >
            <Input />
          </Form.Item>
          <Form.Item
            name="brokerage"
            label="所属门店"
            rules={[{ required: true, message: "请输入门店" }, { max: 80 }]}
          >
            <Input />
          </Form.Item>
        </div>
        <div
          style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}
        >
          <Form.Item
            name="city"
            label="所在城市"
            rules={[{ required: true, message: "请输入城市" }]}
          >
            <Input />
          </Form.Item>
          <Form.Item name="phone" label="联系方式" rules={[{ max: 40 }]}>
            <Input placeholder="演示信息，请勿填写敏感资料" />
          </Form.Item>
        </div>
        <Form.Item name="regions" label="擅长区域">
          <Input placeholder="例如：浦东、徐汇" />
        </Form.Item>
        <Form.Item name="introduction" label="个人介绍" rules={[{ max: 500 }]}>
          <Input.TextArea rows={4} showCount maxLength={500} />
        </Form.Item>
        <Button type="primary" htmlType="submit">
          保存资料
        </Button>
      </Form>
    </>
  );
  const resourceOptions = (type: Resource["type"]) =>
    data.resources
      .filter((item) => item.type === type && item.published && item.installed)
      .map((item) => ({ value: item.id, label: item.name }));
  function reference(id: string): ResourceRef {
    const item = data!.resources.find((resource) => resource.id === id);
    if (!item) throw new Error("模板已失效，请重新选择");
    return { id, version: item.version };
  }
  const defaultsSettings = (
    <>
      <h2 style={{ fontSize: 18, marginTop: 0 }}>默认生成配置</h2>
      <p style={{ color: "#667085", marginBottom: 24 }}>
        初始化新任务时使用，已有工厂草稿和历史任务不受影响。
      </p>
      <Form
        form={defaultsForm}
        layout="vertical"
        style={{ maxWidth: 640 }}
        onFinish={(values) =>
          void act(() => {
            const config: ProductionConfig = {
              ...data.profile.defaults,
              ...values,
              propertyIds: [],
              promptTemplate: reference(values.promptTemplate),
              videoTemplate: reference(values.videoTemplate),
              styleTemplate: reference(values.styleTemplate),
              coverTemplate: reference(values.coverTemplate),
            };
            return demoApi.updateProfile({ defaults: config });
          }, "默认配置已保存，已有草稿保持不变")
        }
      >
        <Form.Item name="videoMode" label="默认视频模式">
          <Radio.Group
            options={[
              { value: "voiceover", label: "纯口播" },
              { value: "avatar", label: "经纪人露脸" },
            ]}
          />
        </Form.Item>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "0 18px",
          }}
        >
          {(
            [
              ["promptTemplate", "提示词模板", "prompt"],
              ["videoTemplate", "视频模板", "video"],
              ["styleTemplate", "风格模板", "style"],
              ["coverTemplate", "封面模板", "cover"],
            ] as const
          ).map(([name, label, type]) => (
            <Form.Item
              key={name}
              name={name}
              label={label}
              rules={[{ required: true, message: `请选择${label}` }]}
            >
              <Select options={resourceOptions(type)} />
            </Form.Item>
          ))}
          <Form.Item
            name="voiceId"
            label="默认音色"
            rules={[{ required: true }]}
          >
            <Select
              options={data.voices
                .filter((item) => item.status === "ready")
                .map((item) => ({ value: item.id, label: item.name }))}
            />
          </Form.Item>
        </div>
        <Form.Item
          name="requireScriptReview"
          label="生成文案后需要人工审核"
          valuePropName="checked"
        >
          <Switch />
        </Form.Item>
        <Button type="primary" htmlType="submit">
          保存默认配置
        </Button>
      </Form>
    </>
  );
  const demoConnections = (
    <>
      <h2 style={{ fontSize: 18, marginTop: 0 }}>平台账号</h2>
      <p style={{ color: "#667085" }}>
        当前连接仅用于演示，不会打开平台登录或读取真实会话。
      </p>
      {(["douyin", "xiaohongshu"] as const).map((platform) => {
        const account = data.accounts.find(
          (item) => item.platform === platform,
        );
        return (
          <div
            key={platform}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 15,
              padding: "24px 0",
              borderBottom: "1px solid #edf0f4",
            }}
          >
            <div>
              <h3 style={{ fontSize: 16, margin: "0 0 7px" }}>
                {platformLabels[platform]}{" "}
                {account?.connected ? (
                  <Tag color="green">模拟已连接</Tag>
                ) : (
                  <Tag>未连接</Tag>
                )}
              </h3>
              <p style={{ color: "#667085", margin: 0 }}>
                {account?.name ?? "尚未添加演示账号"}
              </p>
              {account && (
                <small style={{ color: "#667085" }}>
                  最近检查：
                  {new Date(account.lastCheckedAt).toLocaleString("zh-CN")}
                </small>
              )}
            </div>
            <Space>
              <Button
                onClick={() =>
                  void act(
                    () => demoApi.connectAccount(platform),
                    "模拟连接已更新",
                  )
                }
              >
                {account?.connected ? "检查连接" : "模拟连接"}
              </Button>
              {account?.connected && (
                <Popconfirm
                  title="断开这个演示账号？"
                  description="未完成的发布任务将无法使用该账号。"
                  onConfirm={() =>
                    act(
                      () => demoApi.disconnectAccount(account.id),
                      "账号已断开",
                    )
                  }
                  okText="断开"
                  cancelText="取消"
                >
                  <Button danger>断开连接</Button>
                </Popconfirm>
              )}
            </Space>
          </div>
        );
      })}
    </>
  );
  const storage = (
    <>
      <h2 style={{ fontSize: 18, marginTop: 0 }}>本地存储与下载</h2>
      <Descriptions
        column={1}
        items={[
          {
            key: "size",
            label: isLive ? "当前工作区资料" : "演示业务数据",
            children: `${(new Blob([JSON.stringify(data)]).size / 1024).toFixed(1)} KB`,
          },
          {
            key: "resources",
            label: isLive ? "可选制作模板" : "已安装资源",
            children: isLive
              ? `${data.resources.filter((item) => item.production && item.published).length} 个（由管理员上架，无需安装）`
              : `${data.resources.filter((item) => item.installed).length} 个（模拟安装状态）`,
          },
          {
            key: "storage",
            label: "存储方式",
            children: isLive
              ? "账号资料与创作偏好保存在业务服务；制作素材、文案、配音和成片保存在本机，并按登录账号隔离。"
              : "浏览器本地存储；真实 SQLite 尚未接入",
          },
        ]}
      />
      {!isLive && (
        <>
          <Alert
            type="warning"
            title="重置会清除本环境的演示房源、任务、草稿和设置，恢复初始示例。不会删除磁盘上的用户文件。"
            style={{ margin: "24px 0" }}
          />
          <Popconfirm
            title="重置所有演示数据？"
            description="当前演示草稿和修改将被清除，无法撤销。"
            onConfirm={() => act(() => demoApi.resetDemo(), "演示数据已重置")}
            okText="确认重置"
            cancelText="取消"
          >
            <Button danger icon={<RefreshCw size={15} />}>
              重置演示数据
            </Button>
          </Popconfirm>
        </>
      )}
    </>
  );
  const privacy = (
    <>
      <h2 style={{ fontSize: 18, marginTop: 0 }}>隐私和授权</h2>
      <Space align="start" size={15}>
        <ShieldCheck color="var(--accent)" size={24} />
        <div>
          <strong>使用本人素材，保留明确授权</strong>
          <p style={{ lineHeight: 1.8, color: "#667085", maxWidth: 640 }}>
            {isLive
              ? "本人声音须确认授权后才提交复刻；移除本应用音色不会自动释放供应商槽位。选择 MiniMax 开场时，已授权的参考素材和开场解说会发送给 MiniMax。平台账号由本人在客户端连接，发布前确认目标账号和成片。"
              : "使用本人声音素材需要确认授权。当前演示不上传选择的文件，不读取平台真实账号，也不向陌生用户发送消息。"}
          </p>
        </div>
      </Space>
      <Descriptions
        column={1}
        items={[
          {
            key: "files",
            label: "上传资料",
            children: isLive
              ? "本人声音、照片仅在明确上传和授权后提交；房源素材用于所选制作流程。"
              : "当前仅在本地选择文件，记录示例名称并模拟处理",
          },
          {
            key: "platform",
            label: "平台会话",
            children: isLive
              ? "抖音账号由客户端连接并用于发布；设置页不展示敏感会话内容。"
              : "未接入；不收集或保存真实 Cookie",
          },
          {
            key: "ai",
            label: "AI 请求",
            children: isLive
              ? "按管理员配置调用文案、扩图、配音或 MiniMax 开场服务。原全景素材无需 AI 扩图；服务调用可能产生供应商费用。"
              : "未调用外部供应商；话术和生产结果均为演示",
          },
        ]}
      />
    </>
  );
  const about = (
    <>
      <h2 style={{ fontSize: 18, marginTop: 0 }}>关于 KeAgent Studio</h2>
      <Space size={18} style={{ margin: "18px 0" }}>
        <Monitor size={34} color="var(--accent)" />
        <div>
          <strong style={{ fontSize: 20 }}>KeAgent Studio</strong>
          <p style={{ color: "#667085", margin: "8px 0" }}>
            v0.1.0 · {isLive ? "开发测试版" : "前端演示版"}
          </p>
        </div>
      </Space>
      <p style={{ color: "#667085", maxWidth: 640, lineHeight: 1.8 }}>
        {isLive
          ? "面向房产经纪人的内容生产工作台。支持后台公共模板、原全景或 AI 扩图素材、配音与本地视频合成，并可将正式成果交接至抖音发布中心。各服务状态可在默认生成配置中查看。"
          : "面向房产经纪人的内容生产工作台。当前提供前端演示操作与模拟任务流程。"}
      </p>
      <Button
        icon={<RefreshCw size={15} />}
        onClick={() => message.info("当前为本地开发版本，尚未接入自动更新服务")}
      >
        检查更新
      </Button>
    </>
  );
  const items = [
    { key: "account", label: "账号信息", children: accountSettings },
    { key: "profile", label: "经纪人资料", children: profileSettings },
    {
      key: "voices",
      label: "声音与音色",
      children: isLive ? <VoiceLibraryPanel /> : voiceList,
    },
    {
      key: "platforms",
      label: "平台账号",
      children: isLive ? <DouyinAccounts /> : demoConnections,
    },
    {
      key: "defaults",
      label: "默认生成配置",
      children: isLive ? <FactoryPreferences /> : defaultsSettings,
    },
    { key: "theme", label: "主题设置", children: <ThemeSettings /> },
    { key: "storage", label: "本地存储", children: storage },
    { key: "privacy", label: "隐私和授权", children: privacy },
    { key: "about", label: "软件更新与关于", children: about },
  ];
  return (
    <>
      <PageHeader
        title="设置"
        description="管理个人资料、创作偏好与工作环境。"
      />
      <section className="panel settings-workspace">
        <Tabs
          tabPosition={screens.lg ? "left" : "top"}
          activeKey={
            items.some((item) => item.key === section) ? section : "account"
          }
          onChange={(key) => navigate(`/settings/${key}`)}
          items={items.map((item) => ({
            ...item,
            label: (
              <span className="settings-nav-label">
                {item.key === "account" && <small>个人账号</small>}
                {item.key === "voices" && <small>视频创作</small>}
                {item.key === "theme" && <small>应用设置</small>}
                {item.label}
              </span>
            ),
          }))}
        />
      </section>
      <Modal
        title="创建我的音色"
        open={!!creator}
        onCancel={() => setCreator(false)}
        onOk={() => void createAsset()}
        confirmLoading={busy}
        okText="开始模拟处理"
        destroyOnHidden
      >
        <Alert
          type="info"
          title="仅演示资料提交过程，文件不会离开你的设备。"
          style={{ marginBottom: 20 }}
        />
        <Form layout="vertical">
          <Form.Item label="名称" required>
            <Input
              value={assetName}
              maxLength={40}
              onChange={(event) => setAssetName(event.target.value)}
              placeholder="例如：我的日常口播音色"
            />
          </Form.Item>
          <Form.Item label="本人声音样本" required>
            <Upload
              accept="audio/*"
              showUploadList={false}
              beforeUpload={(file) => {
                if (
                  !file.type.startsWith("audio/") ||
                  file.size > 20 * 1024 * 1024
                ) {
                  message.error("请选择正确类型且不超过 20 MB 的素材");
                  return false;
                }
                setFileName(file.name);
                return false;
              }}
            >
              <Button icon={<UploadCloud size={16} />}>
                {fileName || "选择本人素材"}
              </Button>
            </Upload>
          </Form.Item>
          <Checkbox
            checked={authorized}
            onChange={(event) => setAuthorized(event.target.checked)}
          >
            我确认这是本人的素材，或已获得明确使用授权。
          </Checkbox>
        </Form>
      </Modal>
      <Modal
        title="重命名"
        open={!!renaming}
        onCancel={() => setRenaming(null)}
        onOk={() => {
          if (!renaming?.name.trim()) {
            message.warning("名称不能为空");
            return;
          }
          void act(async () => {
            await demoApi.updateVoice(renaming.id, {
              name: renaming.name.trim(),
            });
            setRenaming(null);
          }, "名称已更新");
        }}
        okText="保存"
      >
        <Input
          aria-label="新的名称"
          value={renaming?.name}
          maxLength={40}
          onChange={(event) =>
            setRenaming((current) =>
              current ? { ...current, name: event.target.value } : current,
            )
          }
        />
      </Modal>
    </>
  );
}
