import { Space, Tag, Timeline } from "antd";
import type {
  DouyinPublishLog,
  DouyinPublishRecord,
} from "@keagent/shared-types";
import { publishingFailureText } from "../lib/douyin";

const primaryLabels: Record<string, string> = {
  check_login: "核对抖音登录",
  open_platform_page: "打开抖音发布页",
  upload_video: "上传视频",
  fill_publish_form: "填写发布文案",
  upload_cover: "上传竖版封面",
  publish_settings: "核对发布设置",
  wait_publish_ready: "等待页面可提交",
  submit_page_request: "提交抖音发布",
  verify_publish_receipt: "核验抖音提交结果",
};
const detailLabels: Record<string, string> = {
  platform_publish: "执行抖音网页发布",
  set_crosspost: "设置同步发布",
  set_visibility: "设置作品可见范围",
  set_download: "设置下载权限",
  set_schedule: "选择发布方式",
  set_scheduled_time: "写入并核对预约时间",
  safety_precheck_unavailable: "抖音预检不可用",
  wait_page_navigation: "等待网页跳转",
  wait_page_control: "等待页面控件",
  click_page_control: "操作页面控件",
  upload_media: "选择本地素材",
  input_text: "输入文字",
  press_key: "发送按键",
};

interface Step extends DouyinPublishLog {
  key: number;
  children: Step[];
}

function groupLogs(logs: DouyinPublishLog[]) {
  const roots: Step[] = [];
  const pending: Step[] = [];
  logs.forEach((log, key) => {
    if (log.status !== "started") {
      const index = pending.map(({ step }) => step).lastIndexOf(log.step);
      if (index >= 0) {
        const [start] = pending.splice(index, 1);
        const elapsed = Date.parse(log.timestamp) - Date.parse(start.timestamp);
        start.status = log.status;
        start.durationMs =
          log.durationMs ?? (elapsed >= 0 ? elapsed : undefined);
        start.errorCode = log.errorCode;
        return;
      }
    }
    const step = { ...log, key, children: [] };
    (pending.at(-1)?.children ?? roots).push(step);
    if (log.status === "started") pending.push(step);
  });
  return roots;
}

function mainSteps(steps: Step[]): Step[] {
  return steps.flatMap((step) => {
    if (Object.hasOwn(primaryLabels, step.step)) return [step];
    const children = mainSteps(step.children);
    if (step.step === "platform_publish" && children.length) {
      return step.status === "failed" &&
        !children.some((child) => child.status === "failed")
        ? [...children, step]
        : children;
    }
    return step.status === "failed" || step.step === "platform_publish"
      ? [step]
      : children;
  });
}

const clock = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
const status = {
  completed: { text: "完成", color: "green" },
  failed: { text: "失败", color: "red" },
  started: { text: "执行中", color: "blue" },
  missing: { text: "未记录结果", color: "gray" },
};
const stepName = (step: Step) =>
  primaryLabels[step.step] || detailLabels[step.step] || "其他平台操作";

export default function PublishExecutionSteps({
  record,
}: {
  record: DouyinPublishRecord;
}) {
  const steps = groupLogs(record.logs ?? []);
  const main = mainSteps(steps);
  const overview = main.length ? main : steps;
  const active = record.state === "running" || record.state === "submitting";
  const flatten = (items: Step[]): Step[] =>
    items.flatMap((step) => [step, ...flatten(step.children)]);
  return (
    <details
      className="publish-execution-steps"
      open={record.state === "failed" || record.state === "unknown"}
    >
      <summary>执行步骤</summary>
      {overview.length ? (
        <Timeline
          items={overview.map((step) => {
            const result =
              status[
                step.status === "started" && !active ? "missing" : step.status
              ];
            const failedChild =
              step.status === "failed"
                ? flatten(step.children).find(
                    (child) => child.status === "failed",
                  )
                : undefined;
            const errorCode =
              failedChild?.errorCode &&
              failedChild.errorCode !== "EXECUTION_FAILED"
                ? failedChild.errorCode
                : step.errorCode;
            const startedAt = Date.parse(step.timestamp);
            return {
              key: step.key,
              color: result.color,
              content: (
                <>
                  <Space size="small" wrap>
                    <strong>{stepName(step)}</strong>
                    <Tag color={result.color}>{result.text}</Tag>
                    <small className="publish-step-meta">
                      {[
                        Number.isFinite(startedAt)
                          ? clock.format(startedAt)
                          : undefined,
                        step.durationMs === undefined
                          ? undefined
                          : step.durationMs >= 1000
                            ? `${(step.durationMs / 1000).toFixed(1)} 秒`
                            : `${step.durationMs} 毫秒`,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </small>
                  </Space>
                  {failedChild && (
                    <div className="publish-step-detail">
                      失败位置 · {stepName(failedChild)}
                    </div>
                  )}
                  {step.status === "failed" &&
                    errorCode &&
                    errorCode !== "EXECUTION_FAILED" &&
                    errorCode !== record.errorCode && (
                      <div className="publish-step-detail">
                        {publishingFailureText(errorCode)}
                      </div>
                    )}
                </>
              ),
            };
          })}
        />
      ) : (
        <p className="muted">暂无执行步骤记录</p>
      )}
      {steps.length > 0 && (
        <details className="publish-step-diagnostics">
          <summary>技术详情</summary>
          <ul>
            {flatten(steps).map((step) => (
              <li key={step.key}>
                {stepName(step)} <code>{step.step}</code>
                {" · "}
                {
                  status[
                    step.status === "started" && !active
                      ? "missing"
                      : step.status
                  ].text
                }
                {step.errorCode && (
                  <>
                    {" "}
                    · <code>{step.errorCode}</code>
                  </>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </details>
  );
}
