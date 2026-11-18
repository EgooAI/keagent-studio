import { queryOptions } from "@tanstack/react-query";
import { creatorHubApi } from "@keagent/api-client";
import type { LeadTrial } from "@keagent/shared-types";

export const leadTrialQuery = queryOptions({
  queryKey: ["lead-trial"],
  queryFn: creatorHubApi.trial,
  refetchInterval: 15000,
  retry: false,
});

export function LeadTrialNotice({ trial }: { trial: LeadTrial }) {
  return (
    <span
      className="muted"
      title="按登录账号共享，每天北京时间零点恢复。模型请求失败也占用额度。"
    >
      今日试用剩余 {trial.analysis.remaining} 条评论分析 ·{" "}
      {trial.draft.remaining} 次草稿
    </span>
  );
}
