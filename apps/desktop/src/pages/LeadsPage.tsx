import { useEffect, useState } from "react";
import {
  Alert,
  Avatar,
  Button,
  Empty,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Tag,
  Timeline,
  message,
} from "antd";
import {
  ArrowUpRight,
  Copy,
  MessageSquareText,
  Plus,
  Search,
  Sparkles,
  UserRound,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { demoApi } from "@keagent/api-client";
import type { Lead, Platform } from "@keagent/shared-types";
import { platformLabels } from "@keagent/shared-types";
import { PageHeader } from "../components/common";
import { useWorkspace } from "../lib/workspace";

const intents = {
  high: { label: "高意向", color: "green" },
  medium: { label: "中意向", color: "orange" },
  low: { label: "低意向", color: "default" },
};
const followupOptions = [
  { value: "new", label: "待跟进" },
  { value: "contacted", label: "已联系" },
  { value: "following", label: "跟进中" },
  { value: "closed", label: "已结束" },
];

export default function LeadsPage() {
  const { data } = useWorkspace();
  const navigate = useNavigate();
  const [selectedId, setSelectedId] = useState("");
  const [search, setSearch] = useState("");
  const [intent, setIntent] = useState("all");
  const [reply, setReply] = useState("");
  const [note, setNote] = useState("");
  const [open, setOpen] = useState(false);
  const [matchesOpen, setMatchesOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form] = Form.useForm<{
    name: string;
    url: string;
    platform: Platform;
  }>();
  const selected =
    data?.leads.find((lead) => lead.id === selectedId) ?? data?.leads[0];
  useEffect(() => {
    setReply(selected?.reply ?? "");
    setNote("");
  }, [selected?.id, selected?.reply]);
  if (!data) return null;
  const filtered = data.leads.filter(
    (lead) =>
      (intent === "all" || lead.intentLevel === intent) &&
      `${lead.name}${lead.commentText}${lead.region}`.includes(search),
  );
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
  async function analyze() {
    setBusy(true);
    try {
      const values = await form.validateFields();
      await demoApi.createLeadAnalysis(
        values.url,
        values.name,
        values.platform,
      );
      setOpen(false);
      form.resetFields();
      message.success("已创建模拟分析任务");
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="AI 获客"
        description="分析授权视频评论，整理购房需求和跟进记录。"
        actions={
          <Button
            type="primary"
            icon={<Plus size={16} />}
            onClick={() => setOpen(true)}
          >
            新建分析任务
          </Button>
        }
      />
      {data.analysisJobs.some((job) => job.status === "running") && (
        <Alert
          type="info"
          showIcon
          title="正在模拟分析评论，结果将自动出现在下方。"
          style={{ marginBottom: 18 }}
        />
      )}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(280px, .8fr) minmax(0, 1.5fr)",
          gap: 20,
          alignItems: "start",
        }}
      >
        <section className="panel" style={{ padding: 18 }}>
          <Input
            prefix={<Search size={16} />}
            placeholder="搜索评论、区域或客户"
            aria-label="搜索线索"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            allowClear
          />
          <Select
            aria-label="意向筛选"
            value={intent}
            onChange={setIntent}
            style={{ width: "100%", margin: "12px 0 16px" }}
            options={[
              { value: "all", label: "全部意向" },
              ...Object.entries(intents).map(([value, item]) => ({
                value,
                label: item.label,
              })),
            ]}
          />
          <div style={{ color: "#667085", fontSize: 12, marginBottom: 8 }}>
            共 {filtered.length} 条示例线索
          </div>
          {filtered.length === 0 ? (
            <Empty description="没有符合条件的线索" />
          ) : (
            filtered.map((lead) => (
              <button
                key={lead.id}
                onClick={() => setSelectedId(lead.id)}
                aria-pressed={selected?.id === lead.id}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  background:
                    selected?.id === lead.id
                      ? "var(--accent-soft)"
                      : "transparent",
                  border: "1px solid",
                  borderColor: selected?.id === lead.id ? "#bfdbfe" : "#edf0f4",
                  borderRadius: 9,
                  padding: 14,
                  marginBottom: 10,
                  cursor: "pointer",
                  font: "inherit",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <Space>
                    <Avatar size={30} icon={<UserRound size={17} />} />
                    <strong>{lead.name}</strong>
                  </Space>
                  <Tag color={intents[lead.intentLevel].color}>
                    {intents[lead.intentLevel].label}
                  </Tag>
                </div>
                <p
                  style={{
                    color: "#475467",
                    lineHeight: 1.65,
                    margin: "10px 0",
                  }}
                >
                  {lead.commentText}
                </p>
                <span style={{ color: "#667085", fontSize: 12 }}>
                  {platformLabels[lead.platform]} ·{" "}
                  {lead.region || "区域未识别"}
                </span>
              </button>
            ))
          )}
          {data.analysisJobs.length > 0 && (
            <details style={{ marginTop: 20 }}>
              <summary style={{ cursor: "pointer", color: "#667085" }}>
                分析任务记录（{data.analysisJobs.length}）
              </summary>
              {data.analysisJobs.map((job) => (
                <div
                  key={job.id}
                  style={{
                    padding: "12px 0",
                    borderBottom: "1px solid #edf0f4",
                  }}
                >
                  <strong>{job.name}</strong>
                  <p style={{ margin: "5px 0", color: "#667085" }}>
                    {job.status === "running" ? "模拟分析中" : "模拟分析完成"} ·{" "}
                    {platformLabels[job.platform]}
                  </p>
                </div>
              ))}
            </details>
          )}
        </section>
        <section className="panel" style={{ padding: 24 }}>
          {!selected ? (
            <Empty description="选择一条线索查看详情" />
          ) : (
            <>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "start",
                  gap: 16,
                }}
              >
                <div>
                  <h2 style={{ margin: "0 0 8px", fontSize: 20 }}>
                    {selected.name}
                  </h2>
                  <Space>
                    <Tag color={intents[selected.intentLevel].color}>
                      {intents[selected.intentLevel].label}
                    </Tag>
                    <span style={{ color: "#667085" }}>
                      {platformLabels[selected.platform]}
                    </span>
                  </Space>
                </div>
                <Select
                  aria-label="跟进状态"
                  value={selected.followupStatus}
                  options={followupOptions}
                  onChange={(value) =>
                    void act(
                      () =>
                        demoApi.updateLead(selected.id, {
                          followupStatus: value as Lead["followupStatus"],
                        }),
                      "跟进状态已更新",
                    )
                  }
                  style={{ width: 120 }}
                />
              </div>
              <div
                style={{
                  padding: 16,
                  background: "#f7f8fa",
                  borderRadius: 8,
                  marginTop: 22,
                }}
              >
                <Space style={{ color: "#667085", fontSize: 12 }}>
                  <MessageSquareText size={14} />
                  原始评论
                </Space>
                <p style={{ margin: "9px 0 0", lineHeight: 1.8 }}>
                  {selected.commentText}
                </p>
                <p
                  style={{ color: "#667085", fontSize: 12, margin: "10px 0 0" }}
                >
                  来源：{selected.sourceVideo}
                </p>
              </div>
              <h3 style={{ fontSize: 15, marginTop: 24 }}>
                需求分析 <Tag>模拟分析</Tag>
              </h3>
              <p style={{ color: "#475467", lineHeight: 1.8 }}>
                {selected.aiSummary}
              </p>
              <dl
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 18,
                  margin: "20px 0",
                }}
              >
                {[
                  ["购房预算", selected.budget],
                  ["意向区域", selected.region],
                  ["户型需求", selected.housingRequirements],
                  ["联系权限", selected.contactPermission],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt
                      style={{
                        color: "#667085",
                        fontSize: 12,
                        marginBottom: 6,
                      }}
                    >
                      {label}
                    </dt>
                    <dd style={{ margin: 0 }}>{value || "未识别"}</dd>
                  </div>
                ))}
              </dl>
              <Button
                onClick={() => setMatchesOpen(true)}
                icon={<ArrowUpRight size={15} />}
              >
                查看可匹配房源
              </Button>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 10,
                  marginTop: 28,
                }}
              >
                <h3 style={{ fontSize: 15, margin: 0 }}>跟进话术</h3>
                <Button
                  size="small"
                  icon={<Sparkles size={14} />}
                  onClick={() =>
                    void act(async () => {
                      setReply(await demoApi.suggestReply(selected.id));
                    }, "已生成示例话术，请确认后使用")
                  }
                >
                  生成话术
                </Button>
              </div>
              <Input.TextArea
                aria-label="跟进话术"
                rows={5}
                value={reply}
                onChange={(event) => setReply(event.target.value)}
                placeholder="点击生成话术，或在这里填写你的跟进建议"
                style={{ marginTop: 12 }}
              />
              <div style={{ textAlign: "right", marginTop: 10 }}>
                <Button
                  icon={<Copy size={14} />}
                  disabled={!reply.trim()}
                  onClick={() =>
                    void act(async () => {
                      await navigator.clipboard.writeText(reply);
                      await demoApi.updateLead(selected.id, { reply });
                    }, "话术已复制")
                  }
                >
                  复制话术
                </Button>
              </div>
              <h3 style={{ fontSize: 15, marginTop: 26 }}>跟进记录</h3>
              <Input.TextArea
                aria-label="跟进备注"
                rows={2}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="记录本次沟通或下一步安排"
              />
              <Button
                style={{ margin: "10px 0 22px" }}
                disabled={!note.trim()}
                onClick={() =>
                  void act(async () => {
                    await demoApi.addFollowup(selected.id, note.trim());
                    setNote("");
                  }, "跟进备注已添加")
                }
              >
                添加记录
              </Button>
              {selected.followups.length ? (
                <Timeline
                  items={selected.followups.map((item) => ({
                    children: (
                      <>
                        <p style={{ margin: 0 }}>{item.note}</p>
                        <small style={{ color: "#667085" }}>
                          {new Date(item.createdAt).toLocaleString("zh-CN")}
                        </small>
                      </>
                    ),
                  }))}
                />
              ) : (
                <p style={{ color: "#667085" }}>还没有跟进记录</p>
              )}
            </>
          )}
        </section>
      </div>
      <Modal
        title="新建评论分析任务"
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => void analyze()}
        confirmLoading={busy}
        okText="开始模拟分析"
        destroyOnHidden
      >
        <Alert
          type="info"
          title="当前使用示例评论进行分析，不会读取真实平台数据。"
          style={{ marginBottom: 20 }}
        />
        <Form
          form={form}
          layout="vertical"
          initialValues={{ platform: "douyin" }}
        >
          <Form.Item
            name="name"
            label="任务名称"
            rules={[
              { required: true, message: "请填写任务名称" },
              { max: 80, message: "任务名称最多 80 字" },
            ]}
          >
            <Input placeholder="例如：浦东两居购房需求" />
          </Form.Item>
          <Form.Item
            name="platform"
            label="来源平台"
            rules={[{ required: true }]}
          >
            <Select
              options={[
                { value: "douyin", label: "抖音" },
                { value: "xiaohongshu", label: "小红书" },
              ]}
            />
          </Form.Item>
          <Form.Item
            name="url"
            label="目标视频链接"
            rules={[
              { required: true, message: "请粘贴视频链接" },
              { type: "url", message: "请输入包含 https:// 的有效链接" },
            ]}
          >
            <Input placeholder="https://…" />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title="可匹配的示例房源"
        open={matchesOpen}
        onCancel={() => setMatchesOpen(false)}
        footer={null}
      >
        {selected &&
          data.properties
            .filter(
              (property) =>
                !selected.region ||
                property.district.includes(selected.region) ||
                selected.region.includes(property.district),
            )
            .slice(0, 4)
            .map((property) => (
              <div
                key={property.id}
                style={{ display: "flex", gap: 12, marginBottom: 16 }}
              >
                <img
                  src={property.image}
                  alt=""
                  style={{
                    width: 100,
                    height: 70,
                    objectFit: "cover",
                    borderRadius: 6,
                  }}
                />
                <div>
                  <strong>{property.community}</strong>
                  <p style={{ color: "#667085", margin: "5px 0" }}>
                    {property.layout} · {property.areaSqm} ㎡
                  </p>
                  <Button
                    type="link"
                    size="small"
                    onClick={() => navigate(`/properties/${property.id}`)}
                  >
                    查看房源
                  </Button>
                </div>
              </div>
            ))}
        {selected &&
          !data.properties.some(
            (property) =>
              !selected.region ||
              property.district.includes(selected.region) ||
              selected.region.includes(property.district),
          ) && (
            <Empty description="暂无区域完全匹配的房源，可前往房源中心补充" />
          )}
      </Modal>
    </>
  );
}
