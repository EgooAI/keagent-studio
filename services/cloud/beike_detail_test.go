package main

import "testing"

const beikeDetailDataFixture = `<参考数据>
<贝壳召回知识>
<小区>
<大西洋新城E区>

{"基本信息": {"容积率": "2.0", "小区ID": "1111027374003", "小区名称": "大西洋新城E区", "建成年代": "2008-2010年", "建筑类型": "塔楼/塔板结合", "总户数": 855, "楼栋数": 6, "物业费用": "2.8元/平米/月", "绿化率": "40%", "租售比": "2.03%"}}

</大西洋新城E区>
</小区>
<房源>
<101138285186>

{"基础信息": {"交易权属": "商品房", "产权年限": "70年", "供暖方式": "集中供暖", "单元总楼层": "26层", "商圈": "望京", "小区": "大西洋新城E区", "小区ID": "1111027374003", "建成年代": "2010年", "建筑面积": "77㎡", "总价": "540万", "单价": "约70000元/平米", "房型": "2室1厅1厨2卫", "房源售卖状态": "在售", "房源年限": "满两年唯一住房", "房源所属楼层": "低楼层", "房源标题": "大西洋新城E区 2室1厅 77㎡ 540万", "房源综合分": 7.0516, "挂牌时间": "2026-06-22 15:06:29", "朝向": "南,西北", "标签": "南北通透", "楼龄": "16年", "用水类型": "民水", "用电类型": "民电", "用途": "普通住宅", "有无燃气": "有燃气"}}

{"学区信息": {}}

</101138285186>
</房源>
</贝壳召回知识>
</参考数据>`

func TestParseBeikeDetail(t *testing.T) {
	details, err := parseBeikeDetail(beikeDetailDataFixture)
	if err != nil || len(details) != 1 {
		t.Fatalf("got %d details, err=%v", len(details), err)
	}
	d := details[0]
	if d.ID != "101138285186" || d.Title != "大西洋新城E区 2室1厅 77㎡ 540万" ||
		d.TotalPriceWan != 540 || d.UnitPrice != 70000 || d.AreaSqm != 77 ||
		d.Layout != "2室1厅1厨2卫" || d.Orientation != "南,西北" || d.Floor != "低楼层" ||
		d.TotalFloors != "26层" || d.BuildingAge != "16年" || d.BuiltYear != "2010年" ||
		d.ListedAt != "2026-06-22 15:06:29" || d.Community != "大西洋新城E区" ||
		d.CommunityID != "1111027374003" || d.District != "望京" || d.Status != "在售" ||
		d.Score != 7.0516 || d.Heating != "集中供暖" || d.Gas != "有燃气" {
		t.Fatalf("unexpected detail: %+v", d)
	}
	if d.CommunityInfo == nil || d.CommunityInfo.PropertyFee != "2.8元/平米/月" ||
		d.CommunityInfo.TotalUnits != 855 || d.CommunityInfo.PlotRatio != "2.0" {
		t.Fatalf("unexpected community info: %+v", d.CommunityInfo)
	}
	if d.School != nil {
		t.Fatalf("empty school info should be omitted, got %v", d.School)
	}
}
