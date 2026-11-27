import type { Property } from "@keagent/shared-types";

const sample = {
  community: "云康园小区",
  areaSqm: 227,
  layout: "5室2厅1厨3卫",
};

export function ListingCoverPreview({
  property = sample,
  reason = "为孩子安家 卖房变现",
  landscape = false,
}: {
  property?: Pick<Property, "community" | "areaSqm" | "layout">;
  reason?: string;
  landscape?: boolean;
}) {
  const width = landscape ? 1280 : 720;
  const height = landscape ? 720 : 1280;
  const rows = [
    property.community || "待填写小区名称",
    reason,
    [property.areaSqm > 0 && `建面${property.areaSqm}㎡`, property.layout]
      .filter(Boolean)
      .join("，") || "待填写房屋信息",
  ];
  const fit = (size: number, text: string) =>
    Math.min(
      size,
      (width * 0.92) /
        Array.from(text).reduce(
          (sum, ch) => sum + (/^[ -~]$/.test(ch) ? 0.65 : 1),
          0,
        ),
    );
  const titleSize = Math.min(fit(70, rows[0]), fit(70, rows[1]));
  return (
    <>
      <video
        aria-label="示例成片第一帧"
        src="/media/demo-property.mp4"
        muted
        playsInline
        preload="auto"
      />
      <svg
        aria-label={rows.join("，")}
        role="img"
        viewBox={`0 0 ${width} ${height}`}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
        }}
        textAnchor="middle"
        fontWeight="bold"
        fontFamily="Microsoft YaHei, PingFang SC, sans-serif"
      >
        {rows.map((text, i) => {
          const size =
            i < 2 ? titleSize : Math.min(fit(49, text), titleSize * 0.82);
          return (
            <text
              key={i}
              x={width / 2}
              y={height * 0.105 + i * 97 + size * 0.85}
              fontSize={size}
              fill={i < 2 ? "#ffd700" : "white"}
              stroke="black"
              strokeWidth={size * 0.17}
              strokeLinejoin="round"
              paintOrder="stroke"
            >
              {text}
            </text>
          );
        })}
      </svg>
    </>
  );
}
