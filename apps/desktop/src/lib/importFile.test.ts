import { describe, expect, it } from "vitest";
import { parseCsv, propertyNumbersFromRows } from "./importFile";
describe("房源文件导入", () => {
  it("识别带BOM和引号的房源号列，允许其他字段中逗号与换行", () => {
    const rows = parseCsv(
      '\uFEFF"说明","房源号"\r\n"浦东,三房","SH1001"\r\n"多行\n说明","SH1002"',
    );
    expect(propertyNumbersFromRows(rows)).toEqual(["SH1001", "SH1002"]);
  });
  it("没有表头时读取首列，保留编号前导零，忽略空行", () => {
    expect(
      propertyNumbersFromRows(parseCsv("00123,示例\n\n00456,测试")),
    ).toEqual(["00123", "00456"]);
  });
  it("拒绝未闭合字段和超过演示上限的输入", () => {
    expect(() => parseCsv('"SH1001')).toThrow("未闭合");
    expect(() =>
      propertyNumbersFromRows(
        Array.from({ length: 501 }, (_, i) => [String(i)]),
      ),
    ).toThrow("500");
  });
});
