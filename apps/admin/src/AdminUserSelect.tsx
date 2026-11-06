import { useState } from "react";
import { Select } from "antd";
import { useQuery } from "@tanstack/react-query";
import { serviceRequest } from "@keagent/api-client";
import type { AdminList, AdminUser } from "@keagent/shared-types";
import { auth, unwrap, userLabel } from "./admin-api";

export default function AdminUserSelect({
  value,
  onChange,
  label = "归属用户",
}: {
  value?: string;
  onChange: (value: string | undefined) => void;
  label?: string;
}) {
  const [search, setSearch] = useState("");
  const users = useQuery({
    queryKey: ["admin", "user-options", search],
    queryFn: () =>
      serviceRequest<AdminList<AdminUser>>(
        `/v1/admin/users/list?limit=20&q=${encodeURIComponent(search)}`,
      ),
  });
  const selected = useQuery({
    queryKey: ["admin", "user", value],
    queryFn: () => unwrap(auth.admin.getUser({ query: { id: value! } })),
    enabled: !!value,
  });
  const options = (users.data?.items || []).map((user) => ({
    value: user.id,
    label: userLabel(user),
  }));
  if (value && !options.some((option) => option.value === value))
    options.unshift({
      value,
      label: selected.data
        ? userLabel(selected.data)
        : selected.isPending
          ? "正在读取用户…"
          : "用户不存在",
    });
  return (
    <Select
      aria-label={label}
      placeholder={`搜索${label}姓名或邮箱`}
      allowClear
      showSearch={{ filterOption: false, onSearch: setSearch }}
      value={value || undefined}
      onChange={onChange}
      loading={users.isFetching}
      options={options}
      style={{ width: 280 }}
      notFoundContent={
        users.error ? "用户读取失败，请重新搜索" : "没有匹配用户"
      }
    />
  );
}
