package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"
)

const avatarSchema = `CREATE TABLE IF NOT EXISTS keagent_panorama_avatar (owner_id text NOT NULL, cache_key text NOT NULL, payload jsonb NOT NULL, PRIMARY KEY(owner_id,cache_key));`

var resourceID = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,150}$`)
var regionID = regexp.MustCompile(`^[a-z0-9-]+$`)
var bucketID = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$`)
var audioObject = regexp.MustCompile(`^[a-f0-9]{64}\.wav$`)

func digestBytes(b []byte) string { d := sha256.Sum256(b); return hex.EncodeToString(d[:]) }
func signMAC(key []byte, value string) []byte {
	h := hmac.New(sha256.New, key)
	h.Write([]byte(value))
	return h.Sum(nil)
}
func providerKey(secret, date, region, service string) []byte {
	return signMAC(signMAC(signMAC(signMAC([]byte(secret), date), region), service), "request")
}
func encodeQuery(q url.Values) string { return strings.ReplaceAll(q.Encode(), "+", "%20") }
func providerHeaders(method string, u *url.URL, body []byte, ak, sk, region, service string, now time.Time, tos bool) http.Header {
	timestamp := now.UTC().Format("20060102T150405Z")
	prefix := "x"
	algorithm := "HMAC-SHA256"
	if tos {
		prefix = "x-tos"
		algorithm = "TOS4-HMAC-SHA256"
	}
	values := map[string]string{"host": u.Host, prefix + "-content-sha256": digestBytes(body), prefix + "-date": timestamp}
	names := []string{}
	for key := range values {
		names = append(names, key)
	}
	sort.Strings(names)
	canonicalHeaders := ""
	headers := http.Header{}
	for _, key := range names {
		canonicalHeaders += key + ":" + values[key] + "\n"
		headers.Set(key, values[key])
	}
	scope := timestamp[:8] + "/" + region + "/" + service + "/request"
	canonical := strings.Join([]string{method, u.EscapedPath(), encodeQuery(u.Query()), canonicalHeaders, strings.Join(names, ";"), digestBytes(body)}, "\n")
	signature := hex.EncodeToString(signMAC(providerKey(sk, timestamp[:8], region, service), algorithm+"\n"+timestamp+"\n"+scope+"\n"+digestBytes([]byte(canonical))))
	headers.Set("Authorization", fmt.Sprintf("%s Credential=%s/%s, SignedHeaders=%s, Signature=%s", algorithm, ak, scope, strings.Join(names, ";"), signature))
	return headers
}
func tosReadURL(u *url.URL, ak, sk, region string, now time.Time) string {
	result := *u
	timestamp := now.UTC().Format("20060102T150405Z")
	scope := timestamp[:8] + "/" + region + "/tos/request"
	q := url.Values{"X-Tos-Algorithm": {"TOS4-HMAC-SHA256"}, "X-Tos-Credential": {ak + "/" + scope}, "X-Tos-Date": {timestamp}, "X-Tos-Expires": {"3600"}, "X-Tos-SignedHeaders": {"host"}}
	canonical := strings.Join([]string{"GET", u.EscapedPath(), encodeQuery(q), "host:" + u.Host + "\n", "host", "UNSIGNED-PAYLOAD"}, "\n")
	q.Set("X-Tos-Signature", hex.EncodeToString(signMAC(providerKey(sk, timestamp[:8], region, "tos"), "TOS4-HMAC-SHA256\n"+timestamp+"\n"+scope+"\n"+digestBytes([]byte(canonical)))))
	result.RawQuery = encodeQuery(q)
	return result.String()
}
func providerBody(ctx context.Context, method, endpoint string, headers http.Header, body []byte, limit int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, method, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, fail(422, "供应商请求无效")
	}
	req.Header = headers
	client, transport := providerClient()
	defer transport.CloseIdleConnections()
	response, err := client.Do(req)
	if err != nil {
		return nil, fail(502, "供应商结果未知，请核对后处理")
	}
	defer response.Body.Close()
	if response.StatusCode/100 != 2 {
		if method == http.MethodPost && response.StatusCode >= 500 {
			return nil, fail(502, "供应商提交结果未知，请核对后处理")
		}
		return nil, fail(502, fmt.Sprintf("供应商 HTTP %d；请检查云端配置，提交结果请先核对", response.StatusCode))
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil || int64(len(data)) > limit {
		if method == http.MethodPost {
			return nil, fail(502, "供应商提交结果未知，请核对后处理")
		}
		return nil, fail(502, "供应商响应不完整或过大")
	}
	return data, nil
}
func visualCall(ctx context.Context, action string, payload object) (object, error) {
	if aiSnapshotFrom(ctx).locked["avatar"] {
		return nil, fail(503, "数字人生效配置无法解密")
	}
	ak, sk := aiValue(ctx, "VOLC_ACCESS_KEY_ID"), aiValue(ctx, "VOLC_SECRET_ACCESS_KEY")
	if ak == "" || sk == "" {
		return nil, fail(503, "云端未配置火山数字人 AK / SK")
	}
	u, _ := url.Parse("https://visual.volcengineapi.com/?Action=" + action + "&Version=2022-08-31")
	body, _ := json.Marshal(payload)
	headers := providerHeaders("POST", u, body, ak, sk, "cn-north-1", "cv", time.Now(), false)
	headers.Set("Content-Type", "application/json")
	data, err := providerBody(ctx, "POST", u.String(), headers, body, 2<<20)
	if err != nil {
		return nil, err
	}
	var output struct {
		Code int    `json:"code"`
		Data object `json:"data"`
	}
	if json.Unmarshal(data, &output) != nil {
		if action == "CVSubmitTask" {
			return nil, fail(502, "数字人提交结果未知，请核对火山控制台")
		}
		return nil, fail(502, "数字人查询返回无效数据")
	}
	if output.Code != 10000 {
		return nil, fail(502, fmt.Sprintf("数字人请求失败（code=%d）", output.Code))
	}
	return output.Data, nil
}
func decodeSpeech(data []byte) ([]byte, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	var audio bytes.Buffer
	for {
		var chunk struct {
			Code int    `json:"code"`
			Data string `json:"data"`
		}
		err := decoder.Decode(&chunk)
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, fail(502, "火山 TTS 响应不完整")
		}
		if chunk.Code != 0 && chunk.Code != 20000000 {
			return nil, fail(502, fmt.Sprintf("火山 TTS code=%d", chunk.Code))
		}
		if chunk.Data != "" {
			part, err := base64.StdEncoding.DecodeString(chunk.Data)
			if err != nil {
				return nil, fail(502, "TTS 音频编码无效")
			}
			audio.Write(part)
		}
	}
	if audio.Len() == 0 || audio.Len()%2 != 0 {
		return nil, fail(502, "TTS 返回空音频或无效 PCM")
	}
	return audio.Bytes(), nil
}
func validOpeningWAV(data []byte) bool {
	if len(data) < 44 || len(data) > 1500000 || string(data[:4]) != "RIFF" || string(data[8:12]) != "WAVE" {
		return false
	}
	formatOK, audioOK := false, false
	for offset := 12; offset+8 <= len(data); {
		size := int(binary.LittleEndian.Uint32(data[offset+4 : offset+8]))
		start := offset + 8
		if size > len(data)-start {
			return false
		}
		switch string(data[offset : offset+4]) {
		case "fmt ":
			if size < 16 {
				return false
			}
			b := data[start : start+16]
			formatOK = binary.LittleEndian.Uint16(b[:2]) == 1 && binary.LittleEndian.Uint16(b[2:4]) == 1 && binary.LittleEndian.Uint32(b[4:8]) == 24000 && binary.LittleEndian.Uint32(b[8:12]) == 48000 && binary.LittleEndian.Uint16(b[12:14]) == 2 && binary.LittleEndian.Uint16(b[14:16]) == 16
		case "data":
			audioOK = size > 0 && size <= 30*48000 && size%2 == 0
		}
		offset = start + size + size%2
	}
	return formatOK && audioOK
}
func tosEndpoint(ctx context.Context) (*url.URL, string, error) {
	return tosLocation(aiValue(ctx, "VOLC_TOS_BUCKET"), aiValue(ctx, "VOLC_TOS_REGION"))
}
func tosLocation(bucket, region string) (*url.URL, string, error) {
	if region == "" {
		region = "cn-beijing"
	}
	if !regionID.MatchString(region) || !bucketID.MatchString(bucket) {
		return nil, "", fail(503, "云端未配置 TOS 私有桶 / 地域")
	}
	u, _ := url.Parse("https://" + bucket + ".tos-" + region + ".volces.com")
	return u, region, nil
}
func (s *server) panorama(ctx context.Context, a actor, operation string, body []byte) (any, error) {
	var input object
	if json.Unmarshal(body, &input) != nil {
		return nil, fail(400, "参数格式无效")
	}
	switch operation {
	case "beike-import", "image-submit", "image-query":
		return s.productionImage(ctx, a, operation, input)
	case "capabilities":
		templates, err := s.productionTemplates(ctx)
		if err != nil {
			return nil, err
		}
		services := aiServicesFor(ctx)
		_, _, imageConfigErr := expansionConnection(ctx)
		return object{"templates": templates, "ai": services[0].State == "configured", "volcTts": services[1].State == "configured", "volcAvatar": services[2].State == "configured", "managedVoices": true, "beike": aiValue(ctx, "BEIKE_ACCESS_TOKEN") != "", "imageExpansion": imageConfigErr == nil}, nil
	case "template":
		return s.productionTemplate(ctx, input)
	case "script-vision":
		template, err := s.productionTemplate(ctx, object{"id": input["templateId"], "version": input["templateVersion"]})
		if err != nil {
			return nil, err
		}
		return generateVisionScript(ctx, template, obj(input["property"]), rows(input["images"]))
	case "script":
		expected := rows(input["segments"])
		language := str(input["language"])
		if len(expected) < 3 || len(expected) > 22 || (language != "zh-CN" && language != "en-US") {
			return nil, fail(422, "文案段落或语言无效")
		}
		content, err := generateWithInstruction(ctx, input, "你是房产视频编导。仅使用输入房源事实和人工标注的空间说明，不编造学区、产权、朝向、收益。按输入模板改写。输出语言 "+language+"。只输出 JSON 数组，每项包含 id 和 text，id和顺序与输入segments一致。开场宜在15秒内读完。")
		if err != nil {
			return nil, fail(502, err.Error())
		}
		content = strings.TrimSpace(content)
		content = strings.TrimPrefix(content, "```json")
		content = strings.TrimPrefix(content, "```")
		content = strings.TrimSuffix(strings.TrimSpace(content), "```")
		var segments []object
		if json.Unmarshal([]byte(content), &segments) != nil || len(segments) != len(expected) {
			return nil, fail(502, "AI 返回无效的分段文案")
		}
		for i, segment := range segments {
			if str(segment["id"]) != str(obj(expected[i])["id"]) || len([]rune(str(segment["text"]))) == 0 || len([]rune(str(segment["text"]))) > 2000 {
				return nil, fail(502, "AI 文案与空间不匹配")
			}
		}
		return segments, nil
	case "tts":
		return s.synthesizeVoice(ctx, a, input)
	case "audio":
		data, err := base64.StdEncoding.DecodeString(str(input["audio"]))
		if err != nil || !validOpeningWAV(data) {
			return nil, fail(422, "开场音频必须为30秒以内的24kHz单声道 WAV")
		}
		u, region, err := tosEndpoint(ctx)
		if err != nil {
			return nil, err
		}
		ak, sk := aiValue(ctx, "VOLC_ACCESS_KEY_ID"), aiValue(ctx, "VOLC_SECRET_ACCESS_KEY")
		if ak == "" || sk == "" {
			return nil, fail(503, "云端未配置火山 AK / SK")
		}
		u.Path = "/keagent/" + digestBytes([]byte(a.UserID)) + "/" + digestBytes(data) + ".wav"
		headers := providerHeaders("PUT", u, data, ak, sk, region, "tos", time.Now(), true)
		headers.Set("Content-Type", "audio/wav")
		if _, err = providerBody(ctx, "PUT", u.String(), headers, data, 1<<20); err != nil {
			return nil, err
		}
		if _, err = s.db.ExecContext(ctx, `INSERT INTO keagent_ai_avatar_audio(owner_id,host,path,version,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour') ON CONFLICT(owner_id,host,path) DO UPDATE SET version=EXCLUDED.version,expires_at=EXCLUDED.expires_at`, a.UserID, u.Host, u.Path, aiSnapshotFrom(ctx).versions["avatar"]); err != nil {
			return nil, err
		}
		return object{"url": tosReadURL(u, ak, sk, region, time.Now())}, nil
	case "avatar-submit":
		avatar, ownErr := s.activeAvatar(ctx, a.UserID, str(input["avatarId"]))
		if ownErr != nil {
			return nil, ownErr
		}
		audioURL, err := url.Parse(str(input["audioUrl"]))
		prefix := "/keagent/" + digestBytes([]byte(a.UserID)) + "/"
		if err != nil || audioURL.Scheme != "https" || audioURL.User != nil || !strings.HasPrefix(audioURL.Path, prefix) || !audioObject.MatchString(strings.TrimPrefix(audioURL.Path, prefix)) {
			return nil, fail(422, "数字人形象或开场音频地址无效")
		}
		version := aiSnapshotFrom(ctx).versions["avatar"]
		err = s.db.QueryRowContext(ctx, `SELECT version FROM keagent_ai_avatar_audio WHERE owner_id=$1 AND host=$2 AND path=$3 AND expires_at>now()`, a.UserID, audioURL.Host, audioURL.Path).Scan(&version)
		if err == nil {
			ctx, err = s.pinnedAI(ctx, "avatar", version)
			if err != nil {
				return nil, err
			}
		} else if !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
		tos, region, tosErr := tosEndpoint(ctx)
		if tosErr != nil || audioURL.Host != tos.Host {
			return nil, fail(422, "开场音频地址无效或配置已变更，请重新上传")
		}
		ak, sk := aiValue(ctx, "VOLC_ACCESS_KEY_ID"), aiValue(ctx, "VOLC_SECRET_ACCESS_KEY")
		if ak == "" || sk == "" {
			return nil, fail(503, "数字人凭证不可用")
		}
		bucket, photoRegion := avatarBucket(ctx, avatar)
		photoURL, photoRegion, photoErr := tosLocation(bucket, photoRegion)
		if photoErr != nil {
			return nil, photoErr
		}
		cacheKey := digestBytes([]byte("photo-v1|" + avatar.ID + "|" + avatar.Hash + "|" + audioURL.Path))
		pending, _ := json.Marshal(object{"submitting": true, "configVersion": version})
		result, err := s.db.ExecContext(ctx, `INSERT INTO keagent_panorama_avatar(owner_id,cache_key,payload) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, a.UserID, cacheKey, pending)
		if err != nil {
			return nil, err
		}
		count, _ := result.RowsAffected()
		if count == 0 {
			var saved []byte
			if err = s.db.QueryRowContext(ctx, `SELECT payload FROM keagent_panorama_avatar WHERE owner_id=$1 AND cache_key=$2`, a.UserID, cacheKey).Scan(&saved); err != nil {
				return nil, err
			}
			var existing object
			if json.Unmarshal(saved, &existing) != nil || str(existing["taskId"]) == "" {
				return nil, fail(409, "数字人提交结果未知，请先在火山控制台核对，避免重复扣费")
			}
			return object{"task_id": existing["taskId"]}, nil
		}
		audioURL.RawQuery = ""
		audioURL.Fragment = ""
		photoURL.Path = avatar.ObjectKey
		data, err := s.avatarVision(ctx, "CVSubmitTask", object{"req_key": photoAvatarProvider, "image_url": tosReadURL(photoURL, ak, sk, photoRegion, time.Now()), "audio_url": tosReadURL(audioURL, ak, sk, region, time.Now())})
		if err != nil {
			return nil, err
		}
		if str(data["task_id"]) == "" {
			return nil, fail(502, "数字人未返回任务 ID，请核对控制台")
		}
		saved, _ := json.Marshal(object{"taskId": str(data["task_id"]), "submitting": false, "provider": photoAvatarProvider, "avatarId": avatar.ID, "configVersion": version})
		if _, err = s.db.ExecContext(ctx, `UPDATE keagent_panorama_avatar SET payload=$3 WHERE owner_id=$1 AND cache_key=$2`, a.UserID, cacheKey, saved); err != nil {
			return nil, fail(502, "数字人已提交但检查点保存失败，请核对控制台")
		}
		return data, nil
	case "avatar-query":
		taskID := str(input["taskId"])
		if taskID == "" || len(taskID) > 150 {
			return nil, fail(422, "数字人任务 ID 无效")
		}
		var saved []byte
		err := s.db.QueryRowContext(ctx, `SELECT payload FROM keagent_panorama_avatar WHERE owner_id=$1 AND payload->>'taskId'=$2`, a.UserID, taskID).Scan(&saved)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, fail(404, "数字人任务不存在或无权访问")
		}
		if err != nil {
			return nil, err
		}
		var checkpoint object
		if json.Unmarshal(saved, &checkpoint) != nil {
			return nil, fail(502, "数字人任务检查点无效")
		}
		provider := str(checkpoint["provider"])
		if provider == "" {
			provider = "realman_avatar_creation_task"
		} // Historical tasks remain queryable.
		ctx, err = s.pinnedAI(ctx, "avatar", int64(number(checkpoint["configVersion"])))
		if err != nil {
			return nil, err
		}
		return s.avatarVision(ctx, "CVGetResult", object{"req_key": provider, "task_id": taskID})
	}
	return nil, fail(404, "全景供应商能力不存在")
}
