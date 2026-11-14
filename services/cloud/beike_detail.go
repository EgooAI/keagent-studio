package main

import (
	"context"
	"encoding/json"
	"regexp"
	"strings"
)

// beikeHouseDetail 是从贝壳 buy detail 回包解析出的二手房详情。
// 相比 search 的摘要，多出挂牌时间、楼龄、产权、供暖、燃气、用水用电等字段。
type beikeHouseDetail struct {
	ID            string             `json:"id"`
	Title         string             `json:"title"`
	TotalPriceWan float64            `json:"totalPriceWan"`
	UnitPrice     float64            `json:"unitPrice"`
	AreaSqm       float64            `json:"areaSqm"`
	Layout        string             `json:"layout"`
	Orientation   string             `json:"orientation"`
	Floor         string             `json:"floor"`
	TotalFloors   string             `json:"totalFloors"`
	BuildingAge   string             `json:"buildingAge"`
	BuiltYear     string             `json:"builtYear"`
	ListedAt      string             `json:"listedAt"`
	Community     string             `json:"community"`
	CommunityID   string             `json:"communityId"`
	District      string             `json:"district"`
	Tags          string             `json:"tags"`
	PropertyYears string             `json:"propertyYears"`
	Transaction   string             `json:"transaction"`
	ListingAge    string             `json:"listingAge"`
	Usage         string             `json:"usage"`
	Status        string             `json:"status"`
	Score         float64            `json:"score"`
	Heating       string             `json:"heating"`
	Gas           string             `json:"gas"`
	Water         string             `json:"water"`
	Electricity   string             `json:"electricity"`
	School        any                `json:"school,omitempty"`
	CommunityInfo *beikeCommunityInfo `json:"communityInfo,omitempty"`
}

type beikeCommunityInfo struct {
	Name          string  `json:"name"`
	CommunityID   string  `json:"communityId"`
	PropertyFee   string  `json:"propertyFee"`
	PlotRatio     string  `json:"plotRatio"`
	GreeningRate  string  `json:"greeningRate"`
	RentRatio     string  `json:"rentRatio"`
	TotalUnits    float64 `json:"totalUnits"`
	BuildingCount float64 `json:"buildingCount"`
	BuildingType  string  `json:"buildingType"`
	BuiltYears    string  `json:"builtYears"`
}

type beikeHouseBasic struct {
	Transaction   string  `json:"交易权属"`
	PropertyYears string  `json:"产权年限"`
	Heating       string  `json:"供暖方式"`
	TotalFloors   string  `json:"单元总楼层"`
	District      string  `json:"商圈"`
	Community     string  `json:"小区"`
	CommunityID   string  `json:"小区ID"`
	BuiltYear     string  `json:"建成年代"`
	AreaSqm       string  `json:"建筑面积"`
	TotalPrice    string  `json:"总价"`
	UnitPrice     string  `json:"单价"`
	Layout        string  `json:"房型"`
	Status        string  `json:"房源售卖状态"`
	ListingAge    string  `json:"房源年限"`
	Floor         string  `json:"房源所属楼层"`
	Title         string  `json:"房源标题"`
	Score         float64 `json:"房源综合分"`
	ListedAt      string  `json:"挂牌时间"`
	Orientation   string  `json:"朝向"`
	Tags          string  `json:"标签"`
	BuildingAge   string  `json:"楼龄"`
	Water         string  `json:"用水类型"`
	Electricity   string  `json:"用电类型"`
	Usage         string  `json:"用途"`
	Gas           string  `json:"有无燃气"`
}

type beikeCommunityBasic struct {
	Name          string  `json:"小区名称"`
	CommunityID   string  `json:"小区ID"`
	PropertyFee   string  `json:"物业费用"`
	PlotRatio     string  `json:"容积率"`
	GreeningRate  string  `json:"绿化率"`
	RentRatio     string  `json:"租售比"`
	TotalUnits    float64 `json:"总户数"`
	BuildingCount float64 `json:"楼栋数"`
	BuildingType  string  `json:"建筑类型"`
	BuiltYears    string  `json:"建成年代"`
}

var (
	beikeCommunitySectionRE = regexp.MustCompile(`(?s)<小区>(.*?)</小区>`)
	beikeCommunityBlockRE   = regexp.MustCompile(`(?s)<([^<>]+)>\s*(.*?)\s*</[^<>]+>`)
	beikeDetailPriceRE      = regexp.MustCompile(`(\d+(?:\.\d+)?)万`)
	beikeDetailUnitRE       = regexp.MustCompile(`(\d+(?:\.\d+)?)元`)
	beikeDetailAreaRE       = regexp.MustCompile(`(\d+(?:\.\d+)?)㎡`)
)

func parseBeikeCommunities(data string) map[string]*beikeCommunityInfo {
	result := map[string]*beikeCommunityInfo{}
	section := beikeCommunitySectionRE.FindStringSubmatch(data)
	if section == nil {
		return result
	}
	for _, block := range beikeCommunityBlockRE.FindAllStringSubmatch(section[1], -1) {
		var wrapper struct {
			Basic beikeCommunityBasic `json:"基本信息"`
		}
		if json.Unmarshal([]byte(block[2]), &wrapper) != nil || wrapper.Basic.CommunityID == "" {
			continue
		}
		basic := wrapper.Basic
		result[basic.CommunityID] = &beikeCommunityInfo{
			Name:          basic.Name,
			CommunityID:   basic.CommunityID,
			PropertyFee:   basic.PropertyFee,
			PlotRatio:     basic.PlotRatio,
			GreeningRate:  basic.GreeningRate,
			RentRatio:     basic.RentRatio,
			TotalUnits:    basic.TotalUnits,
			BuildingCount: basic.BuildingCount,
			BuildingType:  basic.BuildingType,
			BuiltYears:    basic.BuiltYears,
		}
	}
	return result
}

// parseBeikeDetail 从 detail 回包的 data 文本里解析出结构化房源详情（支持多 ID）。
func parseBeikeDetail(data string) ([]beikeHouseDetail, error) {
	communities := parseBeikeCommunities(data)
	section := beikeHouseSectionRE.FindStringSubmatch(data)
	if section == nil {
		return []beikeHouseDetail{}, nil
	}
	blocks := beikeHouseBlockRE.FindAllStringSubmatch(section[1], -1)
	details := make([]beikeHouseDetail, 0, len(blocks))
	for _, block := range blocks {
		dec := json.NewDecoder(strings.NewReader(block[2]))
		var basic struct {
			Basic beikeHouseBasic `json:"基础信息"`
		}
		if err := dec.Decode(&basic); err != nil {
			continue
		}
		var school struct {
			School json.RawMessage `json:"学区信息"`
		}
		_ = dec.Decode(&school)
		b := basic.Basic
		detail := beikeHouseDetail{
			ID:            block[1],
			Title:         b.Title,
			TotalPriceWan: firstRegexpFloat(b.TotalPrice, beikeDetailPriceRE),
			UnitPrice:     firstRegexpFloat(b.UnitPrice, beikeDetailUnitRE),
			AreaSqm:       firstRegexpFloat(b.AreaSqm, beikeDetailAreaRE),
			Layout:        b.Layout,
			Orientation:   b.Orientation,
			Floor:         b.Floor,
			TotalFloors:   b.TotalFloors,
			BuildingAge:   b.BuildingAge,
			BuiltYear:     b.BuiltYear,
			ListedAt:      b.ListedAt,
			Community:     b.Community,
			CommunityID:   b.CommunityID,
			District:      b.District,
			Tags:          b.Tags,
			PropertyYears: b.PropertyYears,
			Transaction:   b.Transaction,
			ListingAge:    b.ListingAge,
			Usage:         b.Usage,
			Status:        b.Status,
			Score:         b.Score,
			Heating:       b.Heating,
			Gas:           b.Gas,
			Water:         b.Water,
			Electricity:   b.Electricity,
		}
		if len(school.School) > 0 && string(school.School) != "{}" {
			var schoolValue any
			if json.Unmarshal(school.School, &schoolValue) == nil {
				detail.School = schoolValue
			}
		}
		if community, ok := communities[b.CommunityID]; ok {
			detail.CommunityInfo = community
		}
		details = append(details, detail)
	}
	return details, nil
}

// beikeDetail 按房源号查询详情，支持一次批量传多个 ID（一次 CLI 子进程调用）。
func beikeDetail(ctx context.Context, city string, ids []string) (object, error) {
	cleaned := make([]string, 0, len(ids))
	for _, id := range ids {
		if id = strings.TrimSpace(id); id != "" {
			cleaned = append(cleaned, id)
		}
	}
	if len(cleaned) == 0 || len(cleaned) > 20 {
		return nil, fail(422, "请填写 1-20 个有效的房源 ID")
	}
	path, key, configured := beikeCLIConfig()
	if !configured {
		return nil, fail(503, "服务端未配置贝壳 CLI（BEIKE_CLI_PATH / BEIKE_MCP_API_KEY）")
	}
	raw, err := runBeikeCLI(ctx, path, key, "detail", city, strings.Join(cleaned, ","))
	if err != nil {
		return nil, beikeCLIError(err)
	}
	var envelope struct {
		Data string `json:"data"`
		OK   bool   `json:"ok"`
	}
	if json.Unmarshal(raw, &envelope) != nil || !envelope.OK {
		return nil, fail(502, "贝壳返回格式不受支持")
	}
	details, err := parseBeikeDetail(envelope.Data)
	if err != nil {
		return nil, fail(502, "贝壳房源回包无法解析")
	}
	return object{"city": city, "returned": len(details), "houses": details}, nil
}
