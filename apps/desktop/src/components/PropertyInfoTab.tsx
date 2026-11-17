import { useState } from "react";
import { Descriptions, Typography } from "antd";
import { Building2, MapPin } from "lucide-react";
import type { Property } from "@keagent/shared-types";
import { formatDate, formatPrice } from "./common";

export function PropertyInfoTab({ property }: { property: Property }) {
  const [failedCover, setFailedCover] = useState<string>();
  const details = property.details;
  const extraFacts = [
    ["挂牌状态", details?.listingStatus],
    ["楼层", details?.floor],
    ["朝向", details?.orientation],
    ["电梯", details?.elevator],
    ["建成年份／楼龄", details?.buildingAge],
    ["交易属性", details?.transactionAttributes],
  ].filter(([, value]) => value);
  const unitPrice =
    !property.sample && property.priceCents > 0 && property.areaSqm > 0
      ? Math.round(property.priceCents / 100 / property.areaSqm)
      : null;

  return (
    <section
      className="property-info-sheet panel"
      aria-labelledby="property-info-title"
    >
      <div className="property-detail-cover">
        {property.image && property.image !== failedCover ? (
          <img
            src={property.image}
            alt={`${property.community} 房源封面`}
            onError={() => setFailedCover(property.image)}
          />
        ) : (
          <span className="property-cover-placeholder">
            <Building2 size={32} aria-hidden="true" />
            暂无房源封面
          </span>
        )}
      </div>
      <div className="property-info-copy">
        <h2 id="property-info-title">{property.title || property.community}</h2>
        <dl className="property-key-facts">
          <div>
            <dt>总价</dt>
            <dd>
              {property.sample ? "未提供" : formatPrice(property.priceCents)}
            </dd>
          </div>
          <div>
            <dt>户型</dt>
            <dd>{property.layout || "未提供"}</dd>
          </div>
          <div>
            <dt>建筑面积</dt>
            <dd>{property.sample ? "未提供" : `${property.areaSqm} m²`}</dd>
          </div>
        </dl>
        {unitPrice !== null && (
          <p className="property-unit-price">
            单价约 {unitPrice.toLocaleString("zh-CN")} 元／平方米
          </p>
        )}
        {extraFacts.length > 0 && (
          <Descriptions
            size="small"
            column={{ xs: 1, sm: 2 }}
            items={extraFacts.map(([label, value]) => ({
              key: label,
              label,
              children: value,
            }))}
          />
        )}
        {property.description && (
          <p className="property-narrative">{property.description}</p>
        )}
        {[
          ["房源详情链接", details?.listingUrl],
          ["VR 看房链接", details?.vrUrl],
        ].map(([label, url]) =>
          url ? (
            <p key={label}>
              <Typography.Text copyable={{ text: url }}>
                {label}
              </Typography.Text>
            </p>
          ) : null,
        )}
        {property.sellingPoints.length > 0 && (
          <ul className="property-detail-tags" aria-label="房源卖点">
            {property.sellingPoints.map((point, index) => (
              <li key={index}>{point}</li>
            ))}
          </ul>
        )}
        <p className="property-verification">
          <MapPin size={16} aria-hidden="true" />
          <span>
            {property.city} {property.district}
          </span>
          <span>资料核验 {formatDate(property.lastVerifiedAt)}</span>
        </p>
      </div>
    </section>
  );
}
