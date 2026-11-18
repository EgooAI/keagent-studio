import { Alert, Button, Descriptions, Form, InputNumber } from "antd";
import { useQuery } from "@tanstack/react-query";
import { serviceRequest } from "@keagent/api-client";
import { useAdminAction } from "./admin-api";

interface TrialLimits {
  analysisLimit: number;
  draftLimit: number;
}

interface TrialOverview {
  limits: TrialLimits;
  today: { analysis: number; drafts: number; accounts: number };
}

const endpoint = "/v1/admin/credits/lead-trial";

export default function LeadTrialPanel() {
  const trial = useQuery({
    queryKey: ["admin", "lead-trial"],
    queryFn: () => serviceRequest<TrialOverview>(endpoint),
    retry: false,
  });
  const action = useAdminAction();
  if (trial.error) {
    return (
      <Alert
        type="error"
        showIcon
        title="无法加载获客试用配置"
        description={trial.error.message}
        action={
          <Button
            loading={trial.isFetching}
            onClick={() => void trial.refetch()}
          >
            重试
          </Button>
        }
      />
    );
  }
  if (!trial.data) return <p role="status">正在加载获客试用配置…</p>;
  const { limits, today } = trial.data;
  return (
    <>
      <Descriptions
        title="今日试用用量"
        size="small"
        extra={
          <Button
            loading={trial.isFetching}
            onClick={() => void trial.refetch()}
          >
            刷新
          </Button>
        }
        items={[
          {
            key: "accounts",
            label: "使用账号",
            children: today.accounts.toLocaleString("zh-CN"),
          },
          {
            key: "analysis",
            label: "评论分析",
            children: today.analysis.toLocaleString("zh-CN"),
          },
          {
            key: "drafts",
            label: "私信草稿",
            children: today.drafts.toLocaleString("zh-CN"),
          },
        ]}
      />
      <p className="admin-muted">
        额度按登录账号共享，每天北京时间零点恢复。模型请求失败也占用额度。设为 0
        可暂停对应功能的试用。
      </p>
      <Form<TrialLimits>
        key={`${limits.analysisLimit}:${limits.draftLimit}`}
        initialValues={limits}
        layout="vertical"
        disabled={action.busy}
        onFinish={(values) =>
          void action.run(
            () => serviceRequest(endpoint, values),
            "获客试用额度已更新",
          )
        }
      >
        <Form.Item
          name="analysisLimit"
          label="每账号每日评论分析额度"
          rules={[{ required: true }]}
        >
          <InputNumber min={0} max={10000} precision={0} />
        </Form.Item>
        <Form.Item
          name="draftLimit"
          label="每账号每日草稿生成额度"
          rules={[{ required: true }]}
        >
          <InputNumber min={0} max={10000} precision={0} />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={action.busy}>
          保存试用额度
        </Button>
      </Form>
    </>
  );
}
