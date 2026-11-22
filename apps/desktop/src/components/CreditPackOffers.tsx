import { Alert, Button } from "antd";
import { useQuery } from "@tanstack/react-query";
import { authRequest } from "@keagent/api-client";
import type { CreditPackPilot } from "@keagent/shared-types";

const formatCredits = new Intl.NumberFormat("zh-CN");
const formatPrice = new Intl.NumberFormat("zh-CN", {
  style: "currency",
  currency: "CNY",
});

export default function CreditPackOffers() {
  const offers = useQuery({
    queryKey: ["credit-pack-offers"],
    queryFn: () => authRequest<CreditPackPilot>("credits.packs"),
    retry: false,
  });
  if (offers.isError)
    return (
      <Alert
        type="warning"
        showIcon
        title="暂时无法获取积分包"
        action={
          <Button size="small" onClick={() => void offers.refetch()}>
            重试
          </Button>
        }
      />
    );
  if (!offers.data?.packs.length) return null;
  const { packs, instructions, typicalVideoCredits } = offers.data;
  return (
    <section className="settings-credit-packs" aria-label="试点积分包">
      <h3>试点积分包</h3>
      <div className="settings-credit-balances">
        {packs.map((pack) => {
          const videoCount = Math.floor(pack.credits / typicalVideoCredits);
          return (
            <div key={pack.id}>
              <span>{pack.id === "starter" ? "体验包" : "常用包"}</span>
              <strong>{formatCredits.format(pack.credits)} 积分</strong>
              {pack.priceFen && (
                <span>{formatPrice.format(pack.priceFen / 100)}</span>
              )}
              <small>
                {videoCount >= 1
                  ? `约 ${formatCredits.format(videoCount)} 条普通房源视频`
                  : `普通房源视频参考用量约 ${formatCredits.format(typicalVideoCredits)} 积分／条`}
              </small>
            </div>
          );
        })}
      </div>
      <p className="muted">
        视频条数按普通房源视频用量估算，实际消耗取决于所选服务。本机开场视频不另计费。
      </p>
      <p className="settings-credit-packs-instructions">{instructions}</p>
    </section>
  );
}
