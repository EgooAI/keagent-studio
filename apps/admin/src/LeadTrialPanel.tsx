import { Alert, Button, Form, InputNumber, Skeleton } from "antd";
import { useQuery } from "@tanstack/react-query";
import { MessageSquareText, RefreshCw, Sparkles, Users } from "lucide-react";
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
  if (!trial.data)
    return (
      <section className="admin-panel" role="status">
        <Skeleton active paragraph={{ rows: 3 }} />
      </section>
    );
  const { limits, today } = trial.data;
  return (
    <div className="admin-stack">
      <section className="admin-panel">
        <div className="admin-section-heading">
          <div>
            <h2>今日试用用量</h2>
            <p className="admin-muted">
              统计今日北京时间零点起各登录账号的 AI 获客试用消耗。
            </p>
          </div>
          <Button
            icon={<RefreshCw size={14} />}
            loading={trial.isFetching}
            onClick={() => void trial.refetch()}
          >
            刷新
          </Button>
        </div>
        <div className="admin-kpi-grid admin-kpi-grid-3">
          <div className="admin-kpi-card">
            <div className="admin-kpi-top">
              <span className="admin-kpi-label">
                <span className="admin-kpi-icon" aria-hidden="true">
                  <Users size={15} />
                </span>
                使用账号
              </span>
            </div>
            <strong className="admin-kpi-value">
              {today.accounts.toLocaleString("zh-CN")}
            </strong>
          </div>
          <div className="admin-kpi-card">
            <div className="admin-kpi-top">
              <span className="admin-kpi-label">
                <span
                  className="admin-kpi-icon admin-kpi-icon-success"
                  aria-hidden="true"
                >
                  <Sparkles size={15} />
                </span>
                评论分析
              </span>
            </div>
            <strong className="admin-kpi-value">
              {today.analysis.toLocaleString("zh-CN")}
            </strong>
          </div>
          <div className="admin-kpi-card">
            <div className="admin-kpi-top">
              <span className="admin-kpi-label">
                <span
                  className="admin-kpi-icon admin-kpi-icon-warning"
                  aria-hidden="true"
                >
                  <MessageSquareText size={15} />
                </span>
                私信草稿
              </span>
            </div>
            <strong className="admin-kpi-value">
              {today.drafts.toLocaleString("zh-CN")}
            </strong>
          </div>
        </div>
      </section>

      <section className="admin-panel admin-settings-panel">
        <div className="admin-section-heading">
          <div>
            <h2>每日试用额度配置</h2>
            <p className="admin-muted">
              额度按登录账号共享，每天北京时间零点恢复。模型请求失败也占用额度。设为
              0 可暂停对应功能的试用。
            </p>
          </div>
        </div>
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
          <div className="admin-form-columns">
            <Form.Item
              name="analysisLimit"
              label="每账号每日评论分析额度"
              rules={[{ required: true }]}
            >
              <InputNumber
                min={0}
                max={10000}
                precision={0}
                style={{ width: "100%" }}
              />
            </Form.Item>
            <Form.Item
              name="draftLimit"
              label="每账号每日草稿生成额度"
              rules={[{ required: true }]}
            >
              <InputNumber
                min={0}
                max={10000}
                precision={0}
                style={{ width: "100%" }}
              />
            </Form.Item>
          </div>
          <Button type="primary" htmlType="submit" loading={action.busy}>
            保存试用额度
          </Button>
        </Form>
      </section>
    </div>
  );
}
