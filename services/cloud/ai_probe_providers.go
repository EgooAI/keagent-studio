package main

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"image"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
	"unicode/utf8"
)

var aiSampleHashes = []string{
	"13f64b98c131b910983c34d7fa54d29ae428472274c9229e0f76614b53733b8a",
	"3fc52cef201709baa151aea666cfcd20fa142043749c1046c9f48868e9308637",
}

func validateAIProbeInput(service, mode string, input object) error {
	if mode == "connection" {
		return nil
	}
	switch service {
	case "script", "expansion":
		count := 2
		if service == "expansion" {
			count = 1
		}
		images := rows(input["images"])
		if len(images) != count {
			return fail(422, "测试示例图片数量无效")
		}
		for i, raw := range images {
			data, err := base64.StdEncoding.Strict().DecodeString(str(raw))
			if err != nil || len(data) > 512<<10 || digestBytes(data) != aiSampleHashes[i] {
				return fail(422, "请使用随后台提供的测试图片")
			}
		}
	case "tts":
		if !resourceID.MatchString(str(input["voiceId"])) {
			return fail(422, "请选择测试用公共音色")
		}
	case "voice-clone":
		if mode == "training" {
			_, err := validateVoiceUpload(object{"name": "管理员复刻测试", "language": "zh-CN", "requestKey": "admin-voice-probe", "authorized": input["authorized"], "format": input["format"], "audio": input["audio"]})
			return err
		}
		if !resourceID.MatchString(str(input["speaker"])) {
			return fail(422, "请填写专用测试音色 ID")
		}
	case "avatar":
		_, _, err := validateAvatarPhoto(object{"name": "管理员数字人测试", "requestKey": "admin-avatar-probe", "photo": input["photo"], "authorized": input["authorized"]})
		return err
	case "beike":
		if input["authorized"] != true {
			return fail(422, "请确认此地址已授权用于测试")
		}
		for _, key := range []string{"cityName", "district", "address"} {
			value := strings.TrimSpace(str(input[key]))
			if value == "" || utf8.RuneCountInString(value) > 300 {
				return fail(422, "请填写授权地址的城市、区县和详细地址")
			}
		}
	}
	return nil
}
func (s *server) performAIProbe(ctx context.Context, p *aiProbe) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	spec, ok := specFor(p.Service)
	if !ok {
		return fail(422, "测试服务无效")
	}
	values, err := readAIValues(ctx, s.db, p.Group, p.Version)
	if err != nil {
		return err
	}
	ctx = withAIGroup(ctx, p.Group, p.Version, values)
	if p.Progress.Task == "" {
		if err = s.aiStep(ctx, p, "检查已保存的配置"); err != nil {
			return err
		}
		missing, issues := aiConfigIssues(spec, values)
		if len(issues) > 0 {
			return fail(422, issues[0])
		}
		if len(missing) > 0 {
			return fail(422, "配置仍有缺项，请补充后重测")
		}
	}
	if p.Mode == "connection" {
		return s.probeAIConnection(ctx, p)
	}
	var input object
	if err = openAI("ai-probe:"+p.ID, p.Input, &input); err != nil {
		return err
	}
	switch p.Service {
	case "script":
		if err = s.aiStep(ctx, p, "验证两张原图的逐图文案"); err != nil {
			return err
		}
		images := []any{}
		for i, value := range rows(input["images"]) {
			images = append(images, object{"id": []string{"probe-photo-1", "probe-photo-2"}[i], "kind": "photo", "jpeg": value})
		}
		template := object{"production": object{"config": object{"language": "zh-CN"}, "scriptRules": object{"overall": "简洁介绍示例房源", "opening": "简短开场", "scene": "按图片可见内容写一段", "closing": "简短结尾"}}}
		_, err = generateVisionScript(ctx, template, object{"title": "服务连通性验证示例房源"}, images)
		return err
	case "tts":
		voice, err := s.activePublicVoice(ctx, str(input["voiceId"]))
		if err != nil {
			return err
		}
		if err = s.aiStep(ctx, p, "合成并校验音频："+voice.Name+"（"+voice.Resource+"）"); err != nil {
			return err
		}
		sentence := "您好，这是配音服务测试。"
		if voice.Language == "en-US" {
			sentence = "This is a voice service test."
		}
		_, err = s.synthesizePCM(ctx, "keagent-ai-probe", sentence, voice.Speaker, voice.Resource, 1)
		return err
	case "voice-clone":
		return s.probeAIClone(ctx, p, input)
	case "beike":
		_, err = s.lookupBeike(ctx, input, func(step string) error { return s.aiStep(ctx, p, step) })
		return err
	case "expansion":
		return s.probeAIExpansion(ctx, p, input)
	case "avatar":
		return s.probeAIAvatar(ctx, p, input)
	}
	return fail(422, "测试服务无效")
}
func (s *server) probeAIConnection(ctx context.Context, p *aiProbe) error {
	if err := s.aiStep(ctx, p, "连接供应商（仅验证网络与 TLS）"); err != nil {
		return err
	}
	endpoint := ""
	for _, service := range aiServicesFor(ctx) {
		if service.ID == p.Service {
			endpoint = service.Endpoint
		}
	}
	if endpoint == "" {
		return fail(422, "服务地址不可用")
	}
	targets := []string{endpoint}
	if p.Service == "avatar" {
		bucket, _, err := tosEndpoint(ctx)
		if err != nil {
			return err
		}
		targets = append(targets, bucket.String())
	}
	client, transport := providerClient()
	defer transport.CloseIdleConnections()
	client.Timeout = 12 * time.Second
	for _, target := range targets {
		req, err := http.NewRequestWithContext(ctx, http.MethodHead, target, nil)
		if err != nil {
			return fail(422, "服务地址无效")
		}
		response, err := client.Do(req)
		if err != nil {
			return fail(422, "无法连接供应商，请检查 DNS、网络或 TLS")
		}
		response.Body.Close()
		if response.StatusCode >= 500 {
			return fail(422, "供应商服务暂不可用")
		}
	}
	p.Progress.Message = "网络连通，尚未验证凭证或生成能力"
	return nil
}
func (s *server) probeAIClone(ctx context.Context, p *aiProbe, input object) error {
	if !cloneConfigured(ctx) {
		return fail(422, "请先打开声音复刻并保存配置")
	}
	speaker := str(input["speaker"])
	if p.Mode == "training" {
		speaker = "keagentprobe" + strings.ReplaceAll(p.ID, "-", "")
		if p.Progress.Task == "" {
			if err := s.aiStep(ctx, p, "提交专用样本训练"); err != nil {
				return err
			}
			raw, err := s.speechCall(ctx, "voice_clone", object{"speaker_id": "custom_speaker_id", "custom_speaker_id": speaker, "language": "zh-CN", "audio": object{"data": input["audio"], "format": input["format"]}}, "")
			if err != nil {
				return err
			}
			var result struct {
				Code *int `json:"code"`
			}
			if json.Unmarshal(raw, &result) != nil || result.Code == nil {
				return fail(502, "训练提交结果未知，请核对供应商")
			}
			if *result.Code != 0 {
				return fail(502, "供应商拒绝测试训练，请检查音色槽位和额度")
			}
			p.Progress.Task = speaker
			if err = s.saveAIProgress(ctx, p); err != nil {
				return err
			}
		}
	}
	for {
		if err := s.aiStep(ctx, p, "查询专用测试音色状态"); err != nil {
			return err
		}
		raw, err := s.speechCall(ctx, "get_voice", object{"speaker_id": "custom_speaker_id", "custom_speaker_id": speaker}, "")
		if err != nil {
			return err
		}
		var voice storedVoice
		if err = voiceResult(&voice, raw); err != nil {
			return err
		}
		if voice.Status == "ready" {
			return nil
		}
		if p.Mode != "training" || voice.Status == "failed" {
			return fail(422, "专用测试音色未就绪，请在火山控制台核对")
		}
		if err = waitAIProbe(ctx); err != nil {
			return err
		}
	}
}
func waitAIProbe(ctx context.Context) error {
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
func (s *server) probeAIExpansion(ctx context.Context, p *aiProbe, input object) error {
	base, headers, err := expansionConnection(ctx)
	if err != nil {
		return err
	}
	if p.Progress.Task == "" {
		if err = s.aiStep(ctx, p, "提交一张示例图扩图"); err != nil {
			return err
		}
		payload, err := expansionPayload(object{"image": rows(input["images"])[0], "prompt": "自然延展室内墙面", "right_scale": 1.2})
		if err != nil {
			return err
		}
		body, _ := json.Marshal(payload)
		submit := headers.Clone()
		submit.Set("X-DashScope-Async", "enable")
		raw, err := s.productionBody(ctx, "POST", base+"/api/v1/services/aigc/image2image/image-synthesis", submit, body, 2<<20)
		if err != nil {
			return err
		}
		var result object
		_ = json.Unmarshal(raw, &result)
		p.Progress.Task = str(obj(result["output"])["task_id"])
		if !resourceID.MatchString(p.Progress.Task) {
			p.Progress.Task = ""
			return fail(502, "扩图提交结果未知，请核对百炼控制台")
		}
		if err = s.saveAIProgress(ctx, p); err != nil {
			return err
		}
	}
	for {
		if err = s.aiStep(ctx, p, "查询扩图并校验图片"); err != nil {
			return err
		}
		raw, err := s.productionBody(ctx, "GET", base+"/api/v1/tasks/"+p.Progress.Task, headers, nil, 2<<20)
		if err != nil {
			return err
		}
		var result object
		if json.Unmarshal(raw, &result) != nil {
			return fail(502, "扩图查询输出无效")
		}
		output := obj(result["output"])
		switch str(output["task_status"]) {
		case "SUCCEEDED":
			files := rows(output["results"])
			if len(files) != 1 {
				return fail(502, "扩图没有返回一张图片")
			}
			file, err := readAIProbeMedia(ctx, str(obj(files[0])["url"]), false)
			if err != nil {
				return err
			}
			if _, _, err = image.DecodeConfig(bytes.NewReader(file)); err != nil {
				return fail(502, "扩图结果不是可读取的图片")
			}
			return nil
		case "PENDING", "RUNNING":
			if err = waitAIProbe(ctx); err != nil {
				return err
			}
		case "FAILED", "CANCELED":
			return fail(502, "扩图任务失败，请在百炼控制台核对权限和额度")
		default:
			return fail(502, "扩图结果未知，请核对百炼控制台")
		}
	}
}

//go:embed ai-probe-speech.wav
var aiProbeSpeech []byte

func aiProbePath(id string) string { return "/keagent/ai-probes/" + id + "/" }
func (s *server) probeAIAvatar(ctx context.Context, p *aiProbe, input object) error {
	tos, region, err := tosEndpoint(ctx)
	if err != nil {
		return err
	}
	prefix := aiProbePath(p.ID)
	if p.Progress.Task == "" {
		if err = s.aiStep(ctx, p, "校验私有桶写入与读取"); err != nil {
			return err
		}
		photo, mime, err := validateAvatarPhoto(object{"name": "管理员数字人测试", "requestKey": "admin-avatar-probe", "photo": input["photo"], "authorized": input["authorized"]})
		if err != nil {
			return err
		}
		audio := aiProbeSpeech
		p.Progress.Assets = true
		if err = s.saveAIProgress(ctx, p); err != nil {
			return err
		}
		for name, file := range map[string]struct {
			data []byte
			mime string
		}{"photo": {photo, mime}, "audio.wav": {audio, "audio/wav"}} {
			if _, err = s.privateObject(ctx, "PUT", prefix+name, file.data, file.mime); err != nil {
				return err
			}
			value, err := s.privateObject(ctx, "GET", prefix+name, nil, "")
			if err != nil {
				return err
			}
			if !bytes.Equal(value, file.data) {
				return fail(502, "私有桶返回的测试文件不一致")
			}
		}
		if err = s.aiStep(ctx, p, "验证旧形象存储位置"); err != nil {
			return err
		}
		if err = s.probeOldAvatarBuckets(ctx, p); err != nil {
			return err
		}
		if err = s.aiStep(ctx, p, "提交测试数字人视频"); err != nil {
			return err
		}
		photoURL, audioURL := *tos, *tos
		photoURL.Path, audioURL.Path = prefix+"photo", prefix+"audio.wav"
		ak, sk := aiValue(ctx, "VOLC_ACCESS_KEY_ID"), aiValue(ctx, "VOLC_SECRET_ACCESS_KEY")
		data, err := s.avatarVision(ctx, "CVSubmitTask", object{"req_key": photoAvatarProvider,
			"image_url": tosReadURL(&photoURL, ak, sk, region, time.Now()), "audio_url": tosReadURL(&audioURL, ak, sk, region, time.Now())})
		if err != nil {
			return err
		}
		p.Progress.Task = str(data["task_id"])
		if !resourceID.MatchString(p.Progress.Task) {
			p.Progress.Task = ""
			return fail(502, "数字人提交结果未知，请核对火山控制台")
		}
		if err = s.saveAIProgress(ctx, p); err != nil {
			return err
		}
	}
	for {
		if err = s.aiStep(ctx, p, "查询数字人并校验视频"); err != nil {
			return err
		}
		data, err := s.avatarVision(ctx, "CVGetResult", object{"req_key": photoAvatarProvider, "task_id": p.Progress.Task})
		if err != nil {
			return err
		}
		detail := obj(data["resp_data"])
		if raw := str(data["resp_data"]); raw != "" {
			_ = json.Unmarshal([]byte(raw), &detail)
		}
		if number(detail["code"]) != 0 {
			return fail(502, "供应商返回数字人处理失败")
		}
		result := str(data["video_url"])
		if result == "" {
			result = str(detail["url"])
		}
		if result == "" {
			result = str(obj(detail["vid"])["url"])
		}
		switch str(data["status"]) {
		case "failed", "not_found", "expired":
			return fail(502, "数字人任务失败、过期或找不到")
		}
		if result != "" {
			raw, err := readAIProbeMedia(ctx, result, true)
			if err != nil {
				return err
			}
			if len(raw) < 12 || string(raw[4:8]) != "ftyp" {
				return fail(502, "数字人结果不是可读取的 MP4")
			}
			return nil
		}
		if str(data["status"]) == "done" {
			return fail(502, "数字人结果缺少视频")
		}
		if err = waitAIProbe(ctx); err != nil {
			return err
		}
	}
}
func readAIProbeMedia(ctx context.Context, raw string, video bool) ([]byte, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.Port() != "" || u.User != nil || u.Fragment != "" {
		return nil, fail(502, "供应商结果地址无效")
	}
	host := strings.ToLower(u.Hostname())
	suffixes := []string{".aliyuncs.com", ".alicdn.com"}
	if video {
		suffixes = []string{".volces.com", ".volccdn.com", ".byteimg.com", ".yangyi08.com"}
	}
	allowed := false
	for _, suffix := range suffixes {
		allowed = allowed || strings.HasSuffix(host, suffix)
	}
	if video {
		for _, configured := range strings.Split(os.Getenv("VOLC_VIDEO_ALLOWED_HOSTS"), ",") {
			allowed = allowed || strings.EqualFold(host, strings.TrimSpace(configured))
		}
	}
	if !allowed {
		return nil, fail(502, "供应商结果域名未授权")
	}
	req, err := http.NewRequestWithContext(ctx, "GET", u.String(), nil)
	if err != nil {
		return nil, fail(502, "供应商结果地址无效")
	}
	limit := int64(12 << 20)
	if video {
		req.Header.Set("Range", "bytes=0-511")
		limit = 512
	}
	client, transport := providerClient()
	defer transport.CloseIdleConnections()
	response, err := client.Do(req)
	if err != nil {
		return nil, fail(502, "无法读取供应商结果")
	}
	defer response.Body.Close()
	if response.StatusCode/100 != 2 {
		return nil, fail(502, "供应商结果不可读取")
	}
	return io.ReadAll(io.LimitReader(response.Body, limit))
}

type aiProbeOldStorage struct {
	Version int64       `json:"version"`
	Origins [][2]string `json:"origins"`
}

func (s *server) probeOldAvatarBuckets(ctx context.Context, p *aiProbe) error {
	active, err := s.activeAI(context.WithValue(ctx, aiContextKey{}, aiSnapshotFrom(context.Background())))
	if err != nil {
		return err
	}
	currentBucket, currentRegion := aiValue(ctx, "VOLC_TOS_BUCKET"), aiValue(ctx, "VOLC_TOS_REGION")
	oldBucket, oldRegion := aiValue(active, "VOLC_TOS_BUCKET"), aiValue(active, "VOLC_TOS_REGION")
	list, err := s.db.QueryContext(ctx, `SELECT $1::text,$2::text UNION SELECT COALESCE(NULLIF(payload->>'bucket',''),$1),COALESCE(NULLIF(payload->>'region',''),$2) FROM keagent_user_avatar WHERE NOT archived`, oldBucket, oldRegion)
	if err != nil {
		return err
	}
	var origins [][2]string
	for list.Next() {
		var origin [2]string
		if err = list.Scan(&origin[0], &origin[1]); err != nil {
			list.Close()
			return err
		}
		if origin[0] != "" && (origin[0] != currentBucket || origin[1] != currentRegion) {
			origins = append(origins, origin)
		}
	}
	err = list.Err()
	list.Close()
	if err != nil {
		return err
	}
	if len(origins) == 0 {
		return nil
	}
	p.Progress.OldStorage = &aiProbeOldStorage{Version: aiSnapshotFrom(active).versions["avatar"], Origins: origins}
	if err = s.saveAIProgress(ctx, p); err != nil {
		return err
	}
	// The existing credential writes the isolated probe; the candidate must be able to read it.
	active = context.WithValue(ctx, aiContextKey{}, aiSnapshotFrom(active))
	for _, origin := range origins {
		path := aiProbePath(p.ID) + "previous-bucket"
		value := []byte("keagent-ai-probe")
		if _, err = s.privateObjectAt(active, "PUT", path, value, "text/plain", origin[0], origin[1]); err != nil {
			return fail(502, "无法在旧存储桶建立权限测试对象")
		}
		actual, readErr := s.privateObjectAt(ctx, "GET", path, nil, "", origin[0], origin[1])
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(active), 10*time.Second)
		_, deleteErr := s.privateObjectAt(cleanup, "DELETE", path, nil, "", origin[0], origin[1])
		cancel()
		if deleteErr != nil {
			return fail(502, "旧存储桶的测试对象清理失败")
		}
		if readErr != nil || !bytes.Equal(actual, value) {
			return fail(502, "新凭证无法读取旧形象所在的存储桶")
		}
	}
	p.Progress.OldStorage = nil
	return s.saveAIProgress(ctx, p)
}
func (s *server) cleanAIProbeAssets(ctx context.Context) {
	p, err := scanAIProbe(s.db.QueryRowContext(ctx, `UPDATE keagent_ai_probe SET lease_until=now()+interval '5 minutes' WHERE id=(
	SELECT id FROM keagent_ai_probe WHERE result->>'assets'='true' AND (lease_until IS NULL OR lease_until<now()) AND
	((status IN ('passed','failed') AND finished_at<now()-interval '5 seconds') OR (status='unknown' AND created_at<now()-interval '1 hour'))
	ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING `+aiProbeReadColumns))
	if err != nil {
		return
	}
	candidate, err := s.pinnedAI(ctx, p.Group, p.Version)
	if err != nil {
		return
	}
	for _, file := range []string{"photo", "audio.wav"} {
		if _, err = s.privateObject(candidate, "DELETE", aiProbePath(p.ID)+file, nil, ""); err != nil && !strings.Contains(err.Error(), "HTTP 404") {
			return
		}
	}
	if old := p.Progress.OldStorage; old != nil {
		active, err := s.pinnedAI(ctx, p.Group, old.Version)
		if err != nil {
			return
		}
		for _, origin := range old.Origins {
			if _, err = s.privateObjectAt(active, "DELETE", aiProbePath(p.ID)+"previous-bucket", nil, "", origin[0], origin[1]); err != nil && !strings.Contains(err.Error(), "HTTP 404") {
				return
			}
		}
	}
	_, _ = s.db.ExecContext(ctx, `UPDATE keagent_ai_probe SET result=result-'assets'-'oldStorage' WHERE id=$1`, p.ID)
}
