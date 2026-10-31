export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const source = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '"') {
      if (quoted && source[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (quoted || !cell.trim()) quoted = !quoted;
      else cell += char;
    } else if (!quoted && (char === "," || char === "\t")) {
      row.push(cell.trim());
      cell = "";
    } else if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && source[i + 1] === "\n") i++;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }
  if (quoted) throw new Error("CSV 引号未闭合，请检查文件格式");
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

export function propertyNumbersFromRows(rows: unknown[][]): string[] {
  const header = rows[0]?.map((value) => String(value).trim()) ?? [];
  const column = header.findIndex((value) =>
    ["房源号", "propertyNumber", "房源编号"].includes(value),
  );
  const numbers = rows
    .slice(column >= 0 ? 1 : 0)
    .map((row) => String(row[column >= 0 ? column : 0] ?? "").trim())
    .filter(Boolean);
  if (numbers.length > 500)
    throw new Error("演示模式每次最多导入 500 个房源号，请拆分文件");
  return numbers;
}
