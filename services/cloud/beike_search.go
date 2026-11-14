package main

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strconv"
)

// beikeHouse 是从贝壳 buy search 回包中解析出的二手房结构化摘要。
// 字段映射自 <贝壳召回知识><房源><ID> 内嵌 JSON 的「摘要信息」。
type beikeHouse struct {
	ID            string  `json:"id"`
	Title         string  `json:"title"`
	TotalPriceWan float64 `json:"totalPriceWan"`
	UnitPrice     float64 `json:"unitPrice"`
	Layout        string  `json:"layout"`
	AreaSqm       float64 `json:"areaSqm"`
	Orientation   string  `json:"orientation"`
	Community     string  `json:"community"`
	District      string  `json:"district"`
	Metro         string  `json:"metro,omitempty"`
	Floor         string  `json:"floor,omitempty"`
	School        string  `json:"school,omitempty"`
	Transaction   string  `json:"transaction,omitempty"`
	Highlights    string  `json:"highlights,omitempty"`
	Score         float64 `json:"score,omitempty"`
	Status        string  `json:"status,omitempty"`
	Scarcity      string  `json:"scarcity,omitempty"`
}

type beikeHouseBlock struct {
	Summary beikeHouseSummary `json:"摘要信息"`
}

type beikeHouseSummary struct {
	HouseID       string  `json:"房源ID"`
	Title         string  `json:"房源标题"`
	PriceInfo     string  `json:"价格信息"`
	LayoutInfo    string  `json:"户型信息"`
	CommunityInfo string  `json:"小区信息"`
	LocationInfo  string  `json:"区位交通"`
	School        string  `json:"学区信息"`
	Transaction   string  `json:"交易信息"`
	Highlights    string  `json:"房源亮点"`
	Score         float64 `json:"房源分"`
	Status        string  `json:"房源售卖状态"`
	Floor         string  `json:"房源所在楼层信息"`
	Scarcity      string  `json:"房源稀缺性"`
}

var (
	beikeHouseSectionRE = regexp.MustCompile(`(?s)<房源>(.*?)</房源>`)
	beikeHouseBlockRE   = regexp.MustCompile(`(?s)<(\d+)>\s*(.*?)\s*</\d+>`)
	beikeConditionsRE   = regexp.MustCompile(`(?s)【本次实际命中的检索条件】\s*(\[[^\]]*\])`)
	beikeTotalRE        = regexp.MustCompile(`总召回结果数：(\d+)`)
	beikeBudgetMaxRE    = regexp.MustCompile(`(\d+(?:\.\d+)?)\s*万(?:元)?\s*(?:以内|以下|之内|内)`)

	beikePriceTotalRE = regexp.MustCompile(`总价(\d+(?:\.\d+)?)万`)
	beikePriceUnitRE  = regexp.MustCompile(`单价约?(\d+(?:\.\d+)?)元`)
	beikeLayoutRE     = regexp.MustCompile(`(\d+室\d+厅(?:\d+厨)?\d+卫)`)
	beikeAreaRE       = regexp.MustCompile(`建筑面积(\d+(?:\.\d+)?)㎡`)
	beikeOrientRE     = regexp.MustCompile(`朝向(.+)$`)
	beikeCommunityRE  = regexp.MustCompile(`^([^（(，,]+)`)
	beikeDistrictRE   = regexp.MustCompile(`位于(.+?区)`)
	beikeMetroRE      = regexp.MustCompile(`距离(.+?)步行距离(\d+)米`)
)

func firstRegexpFloat(s string, re *regexp.Regexp) float64 {
	if m := re.FindStringSubmatch(s); m != nil {
		if v, err := strconv.ParseFloat(m[1], 64); err == nil {
			return v
		}
	}
	return 0
}

func firstRegexpString(s string, re *regexp.Regexp) string {
	if m := re.FindStringSubmatch(s); m != nil {
		return m[1]
	}
	return ""
}

// parseBeikeHouses 从 search 回包的 data 文本里解析出结构化房源列表。
// 返回空列表而非 nil，保证 JSON 编码为 [] 而不是 null。
func parseBeikeHouses(data string) ([]beikeHouse, error) {
	section := beikeHouseSectionRE.FindStringSubmatch(data)
	if section == nil {
		return []beikeHouse{}, nil
	}
	blocks := beikeHouseBlockRE.FindAllStringSubmatch(section[1], -1)
	houses := make([]beikeHouse, 0, len(blocks))
	for _, block := range blocks {
		var parsed beikeHouseBlock
		if json.Unmarshal([]byte(block[2]), &parsed) != nil {
			continue
		}
		summary := parsed.Summary
		metro := ""
		if m := beikeMetroRE.FindStringSubmatch(summary.LocationInfo); m != nil {
			metro = m[1] + "步行" + m[2] + "米"
		}
		houses = append(houses, beikeHouse{
			ID:            summary.HouseID,
			Title:         summary.Title,
			TotalPriceWan: firstRegexpFloat(summary.PriceInfo, beikePriceTotalRE),
			UnitPrice:     firstRegexpFloat(summary.PriceInfo, beikePriceUnitRE),
			Layout:        firstRegexpString(summary.LayoutInfo, beikeLayoutRE),
			AreaSqm:       firstRegexpFloat(summary.LayoutInfo, beikeAreaRE),
			Orientation:   firstRegexpString(summary.LayoutInfo, beikeOrientRE),
			Community:     firstRegexpString(summary.CommunityInfo, beikeCommunityRE),
			District:      firstRegexpString(summary.LocationInfo, beikeDistrictRE),
			Metro:         metro,
			Floor:         summary.Floor,
			School:        summary.School,
			Transaction:   summary.Transaction,
			Highlights:    summary.Highlights,
			Score:         summary.Score,
			Status:        summary.Status,
			Scarcity:      summary.Scarcity,
		})
	}
	return houses, nil
}

func parseBeikeConditions(data string) []any {
	m := beikeConditionsRE.FindStringSubmatch(data)
	if m == nil {
		return []any{}
	}
	var conditions []any
	if json.Unmarshal([]byte(m[1]), &conditions) != nil {
		return []any{}
	}
	return conditions
}

func parseBeikeTotal(data string) int {
	if m := beikeTotalRE.FindStringSubmatch(data); m != nil {
		if v, err := strconv.Atoi(m[1]); err == nil {
			return v
		}
	}
	return 0
}

// parseBeikeBudget 从查询文本中解析严格预算上限（万元）。仅识别「N万以内/以下/之内/内」，
// 不识别「N万」这类目标价位，避免把「500万两居」误当成硬上限。无匹配时返回 nil。
func parseBeikeBudget(query string) *float64 {
	if m := beikeBudgetMaxRE.FindStringSubmatch(query); m != nil {
		if v, err := strconv.ParseFloat(m[1], 64); err == nil {
			return &v
		}
	}
	return nil
}

func filterBeikeHouses(houses []beikeHouse, budget *float64) (within, over []beikeHouse) {
	within = make([]beikeHouse, 0, len(houses))
	over = make([]beikeHouse, 0)
	if budget == nil {
		return houses, over
	}
	for _, house := range houses {
		if house.TotalPriceWan > 0 && house.TotalPriceWan > *budget {
			over = append(over, house)
		} else {
			within = append(within, house)
		}
	}
	return within, over
}

// beikeSearch 执行「按需求找房」：调用 search，解析结构化房源，按严格预算二次过滤。
func beikeSearch(ctx context.Context, city, query string) (object, error) {
	path, key, configured := beikeCLIConfig()
	if !configured {
		return nil, fail(503, "服务端未配置贝壳 CLI（BEIKE_CLI_PATH / BEIKE_MCP_API_KEY）")
	}
	raw, err := runBeikeCLI(ctx, path, key, "search", city, query)
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
	houses, err := parseBeikeHouses(envelope.Data)
	if err != nil {
		return nil, fail(502, "贝壳房源回包无法解析")
	}
	budget := parseBeikeBudget(query)
	within, over := filterBeikeHouses(houses, budget)
	return object{
		"city":           city,
		"query":          query,
		"totalRecalled":  parseBeikeTotal(envelope.Data),
		"returned":       len(houses),
		"conditions":     parseBeikeConditions(envelope.Data),
		"strictBudgetWan": budget,
		"houses":         within,
		"overBudget":     over,
	}, nil
}

func beikeCLIError(err error) error {
	switch {
	case errors.Is(err, errBeikeCLIRejected):
		return fail(502, "贝壳拒绝当前客户端请求，请检查服务端客户端身份配置")
	case errors.Is(err, errBeikeCLIExecution):
		return fail(502, "贝壳 CLI 执行失败")
	case errors.Is(err, errBeikeCLIBusiness):
		return fail(502, "贝壳返回业务错误")
	case errors.Is(err, errBeikeCLIInvalidOutput):
		return fail(502, "贝壳返回格式不受支持")
	case errors.Is(err, errBeikeCLIOutputLimit):
		return fail(502, "贝壳输出超过上限")
	case errors.Is(err, context.DeadlineExceeded):
		return fail(504, "贝壳查询超时")
	}
	return fail(502, "贝壳查询失败")
}
