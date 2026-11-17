import { Table, type TableProps } from "antd";
import "./lead-table.css";

/** Keep field names next to their values when a table row stacks on small screens. */
export default function LeadTable<Row extends object>({
  columns,
  className,
  ...props
}: TableProps<Row>) {
  return (
    <Table<Row>
      {...props}
      className={["lead-table", className].filter(Boolean).join(" ")}
      columns={columns?.map((column) => ({
        ...column,
        onCell: (row, index) => ({
          ...column.onCell?.(row, index),
          "data-label": typeof column.title === "string" ? column.title : "",
        }),
      }))}
    />
  );
}
