package main

import "testing"

const beikeSearchDataFixture = `<参考数据>
<数据查询>
- 查询目标实体类型：房源
- 查询问题：在售二手房，望京 两居 500万以内

【本次实际命中的检索条件】
[{"查询条件": "500万以内", "检索条件": "卖房总价 < 550.0", "match_type": "EXACT"}, {"查询条件": "两居", "检索条件": "卧室数 = 2.0", "match_type": "EXACT"}]

【检索概览】
- 总召回结果数：688
- 推荐展示数量（TopK）：2
</数据查询>
<贝壳召回知识>
<房源>
<101138285186>

{"摘要信息": {"价格信息": "总价540万，单价约70000元/平米", "户型信息": "2室1厅1厨2卫，建筑面积77㎡，使用面积54㎡，朝向南,西北", "小区信息": "大西洋新城E区(小区ID:1111027374003)，2008-2010年年建成", "区位交通": "位于朝阳区望京小区大西洋新城E区，距离阜通地铁站（14号线）步行距离744米，步行约12分钟", "房源ID": "101138285186", "房源分": 7.0516, "房源售卖状态": "在售", "房源所在楼层信息": "低楼层，总楼层共26层", "房源标题": "大西洋新城E区 2室1厅 77㎡ 540万", "交易信息": "产权70年", "房源亮点": "南北通透", "学区信息": "三帆中学"}}

</101138285186>

<101140586826>

{"摘要信息": {"价格信息": "总价526万，单价约53000元/平米", "户型信息": "2室2厅1厨1卫，建筑面积99㎡，使用面积68㎡，朝向东南", "小区信息": "利泽西园(小区ID:1111027378232)，1998-2005年年建成", "区位交通": "位于朝阳区望京小区利泽西园，距离东湖渠地铁站（14号线）步行距离487米，步行约8分钟", "房源ID": "101140586826", "房源分": 8.52706, "房源售卖状态": "在售", "房源所在楼层信息": "中楼层，总楼层共24层", "房源标题": "利泽西园 2室2厅 99㎡ 526万", "交易信息": "产权70年", "房源亮点": "近地铁", "学区信息": "陈经纶中学"}}

</101140586826>
</房源>
</贝壳召回知识>
</参考数据>`

func TestParseBeikeHouses(t *testing.T) {
	houses, err := parseBeikeHouses(beikeSearchDataFixture)
	if err != nil || len(houses) != 2 {
		t.Fatalf("got %d houses, err=%v", len(houses), err)
	}
	first := houses[0]
	if first.ID != "101138285186" || first.Title != "大西洋新城E区 2室1厅 77㎡ 540万" ||
		first.TotalPriceWan != 540 || first.UnitPrice != 70000 || first.Layout != "2室1厅1厨2卫" ||
		first.AreaSqm != 77 || first.Orientation != "南,西北" || first.Community != "大西洋新城E区" ||
		first.District != "朝阳区" || first.Metro != "阜通地铁站（14号线）步行744米" ||
		first.Floor != "低楼层，总楼层共26层" || first.Status != "在售" || first.Score != 7.0516 {
		t.Fatalf("unexpected first house: %+v", first)
	}
	second := houses[1]
	if second.ID != "101140586826" || second.TotalPriceWan != 526 || second.Orientation != "东南" ||
		second.Metro != "东湖渠地铁站（14号线）步行487米" || second.Community != "利泽西园" {
		t.Fatalf("unexpected second house: %+v", second)
	}
}

func TestParseBeikeConditions(t *testing.T) {
	conditions := parseBeikeConditions(beikeSearchDataFixture)
	if len(conditions) != 2 || str(obj(conditions[0])["检索条件"]) != "卖房总价 < 550.0" {
		t.Fatalf("unexpected conditions: %v", conditions)
	}
	if got := parseBeikeTotal(beikeSearchDataFixture); got != 688 {
		t.Fatalf("total = %d", got)
	}
}

func TestParseBeikeBudget(t *testing.T) {
	for _, tc := range []struct {
		query string
		want  *float64
	}{
		{"望京 两居 500万以内", fptr(500)},
		{"国贸 一居室 400万以内", fptr(400)},
		{"望京 500万以下", fptr(500)},
		{"望京 两居 500万", nil},
		{"望京 两居", nil},
	} {
		got := parseBeikeBudget(tc.query)
		if (got == nil) != (tc.want == nil) || (got != nil && *got != *tc.want) {
			t.Fatalf("parseBeikeBudget(%q) = %v, want %v", tc.query, got, tc.want)
		}
	}
}

func TestFilterBeikeHouses(t *testing.T) {
	houses := []beikeHouse{
		{ID: "over", TotalPriceWan: 540},
		{ID: "within", TotalPriceWan: 498},
		{ID: "unknown", TotalPriceWan: 0},
	}
	within, over := filterBeikeHouses(houses, fptr(500))
	if len(within) != 2 || within[0].ID != "within" || within[1].ID != "unknown" || len(over) != 1 || over[0].ID != "over" {
		t.Fatalf("budget 500: within=%v over=%v", within, over)
	}
	within, over = filterBeikeHouses(houses, nil)
	if len(within) != 3 || len(over) != 0 {
		t.Fatalf("nil budget: within=%d over=%d", len(within), len(over))
	}
}

func fptr(f float64) *float64 { return &f }
