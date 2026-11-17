import type { ReactNode } from "react";
import { Tag } from "antd";
import {
  statusLabels,
  publishLabels,
  type Property,
} from "@keagent/shared-types";

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      <div className="page-actions">{actions}</div>
    </div>
  );
}

const colors: Record<string, string> = {
  queued: "default",
  running: "processing",
  awaiting_review: "orange",
  succeeded: "success",
  failed: "error",
  canceled: "default",
  draft_saved: "blue",
  published: "success",
  unknown: "orange",
  ready: "success",
  processing: "processing",
};
const labels: Record<string, string> = {
  ...statusLabels,
  ...publishLabels,
  ready: "可用",
  processing: "处理中",
};
export function StatusTag({
  status,
  label,
}: {
  status: string;
  label?: string;
}) {
  return (
    <Tag color={colors[status]} variant="filled">
      {label ?? labels[status] ?? status}
    </Tag>
  );
}

export function formatPrice(priceCents: number) {
  return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(priceCents / 1000000)} 万`;
}
export function formatDate(value: string | null | undefined) {
  const date = new Date(value ?? "");
  if (Number.isNaN(date.getTime())) return "未提供";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function PropertyPhoto({
  property,
  className = "",
}: {
  property: Property;
  className?: string;
}) {
  return (
    <img
      className={`property-photo ${className}`}
      src={property.image || undefined}
      alt={property.image ? `${property.community} 房源封面` : "未添加封面"}
      loading="lazy"
    />
  );
}
