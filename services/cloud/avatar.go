package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"os"
	"strings"
	"time"
)

const photoAvatarProvider = "jimeng_realman_avatar_picture_omni_v2"
const userAvatarSchema = `CREATE TABLE IF NOT EXISTS keagent_user_avatar (
 id text PRIMARY KEY,owner_id text NOT NULL,request_key text NOT NULL,fingerprint text NOT NULL,
 payload jsonb NOT NULL,archived boolean NOT NULL DEFAULT false,UNIQUE(owner_id,request_key));
 CREATE INDEX IF NOT EXISTS keagent_user_avatar_owner_idx ON keagent_user_avatar(owner_id) WHERE NOT archived;`
const maxAvatarPhoto = 5 * 1024 * 1024

type userAvatar struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Status    string `json:"status"`
	Error     string `json:"error,omitempty"`
	CreatedAt string `json:"createdAt"`
}
type storedAvatar struct {
	userAvatar
	ObjectKey    string `json:"objectKey"`
	Hash         string `json:"hash"`
	Mime         string `json:"mime"`
	AuthorizedAt string `json:"authorizedAt"`
	Version      int64  `json:"version"`
}

func validateAvatarPhoto(input object) ([]byte, string, error) {
	if input["authorized"] != true {
		return nil, "", fail(422, "请确认上传的是本人照片并同意用于数字人制作")
	}
	name, key := strings.TrimSpace(str(input["name"])), str(input["requestKey"])
	if name == "" || len([]rune(name)) > 40 || len(key) < 16 || len(key) > 100 {
		return nil, "", fail(422, "形象名称或请求标识无效")
	}
	encoded := str(input["photo"])
	if len(encoded) > base64.StdEncoding.EncodedLen(maxAvatarPhoto) {
		return nil, "", fail(413, "照片不能超过5 MB")
	}
	data, err := base64.StdEncoding.Strict().DecodeString(encoded)
	if err != nil || len(data) < 32 || len(data) > maxAvatarPhoto {
		return nil, "", fail(422, "照片无效或超过5 MB")
	}
	info, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || (format != "jpeg" && format != "png") || info.Width < 1 || info.Height < 1 || info.Width > 4096 || info.Height > 4096 {
		return nil, "", fail(422, "请上传4096×4096以内的 JPEG / PNG 本人照片")
	}
	mime := "image/jpeg"
	if format == "png" {
		mime = "image/png"
	}
	return data, mime, nil
}
func (s *server) privateObject(ctx context.Context, method, key string, data []byte, mime string) ([]byte, error) {
	if s.storage != nil {
		return s.storage(ctx, method, key, data, mime)
	}
	u, region, err := tosEndpoint()
	if err != nil {
		return nil, err
	}
	ak, sk := os.Getenv("VOLC_ACCESS_KEY_ID"), os.Getenv("VOLC_SECRET_ACCESS_KEY")
	if ak == "" || sk == "" {
		return nil, fail(503, "云端未配置照片私有存储凭证")
	}
	u.Path = key
	headers := providerHeaders(method, u, data, ak, sk, region, "tos", time.Now(), true)
	if method == "PUT" {
		headers.Set("Content-Type", mime)
	}
	return providerBody(ctx, method, u.String(), headers, data, maxAvatarPhoto)
}
func (s *server) avatarVision(ctx context.Context, action string, payload object) (object, error) {
	if s.vision != nil {
		return s.vision(ctx, action, payload)
	}
	return visualCall(ctx, action, payload)
}
func (s *server) ownedAvatar(ctx context.Context, owner, avatarID string) (storedAvatar, error) {
	var v storedAvatar
	var raw []byte
	if avatarID == "" {
		return v, fail(422, "请先上传本人照片并选择形象")
	}
	err := s.db.QueryRowContext(ctx, `SELECT payload FROM keagent_user_avatar WHERE id=$1 AND owner_id=$2 AND NOT archived`, avatarID, owner).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return v, fail(404, "本人形象不存在或无权访问，请先上传本人照片")
	}
	if err != nil {
		return v, err
	}
	err = json.Unmarshal(raw, &v)
	return v, err
}
func (s *server) activeAvatar(ctx context.Context, owner, avatarID string) (storedAvatar, error) {
	v, err := s.ownedAvatar(ctx, owner, avatarID)
	if err != nil {
		return v, err
	}
	if v.Status != "ready" {
		return v, fail(409, "本人照片尚未保存成功，请刷新状态后再制作")
	}
	return v, nil
}
func (s *server) saveAvatarStatus(ctx context.Context, owner string, v storedAvatar) error {
	patch, _ := json.Marshal(object{"status": v.Status, "error": v.Error, "version": v.Version + 1})
	_, err := s.db.ExecContext(ctx, `UPDATE keagent_user_avatar SET payload=payload || $3::jsonb WHERE id=$1 AND owner_id=$2 AND NOT archived AND COALESCE((payload->>'version')::bigint,0)=$4`, v.ID, owner, patch, v.Version)
	return err
}
func (s *server) avatars(ctx context.Context, a actor, operation string, body []byte) (any, error) {
	var input object
	if json.Unmarshal(body, &input) != nil {
		return nil, fail(400, "请求格式无效")
	}
	if operation == "list" {
		records, err := s.db.QueryContext(ctx, `SELECT payload FROM keagent_user_avatar WHERE owner_id=$1 AND NOT archived ORDER BY payload->>'createdAt' DESC`, a.UserID)
		if err != nil {
			return nil, err
		}
		defer records.Close()
		result := []userAvatar{}
		for records.Next() {
			var raw []byte
			var v storedAvatar
			if err = records.Scan(&raw); err != nil {
				return nil, err
			}
			if err = json.Unmarshal(raw, &v); err != nil {
				return nil, err
			}
			result = append(result, v.userAvatar)
		}
		return object{"avatars": result, "uploadEnabled": aiServices()[2].State == "configured"}, records.Err()
	}
	if operation == "create" {
		data, mime, err := validateAvatarPhoto(input)
		if err != nil {
			return nil, err
		}
		if aiServices()[2].State != "configured" {
			return nil, fail(503, "管理员尚未配置本人照片的私有存储及数字人服务")
		}
		hash := digestBytes(data)
		fingerprint := digestBytes([]byte(strings.TrimSpace(str(input["name"])) + "|" + hash))
		avatarID := id()
		extension := "jpg"
		if mime == "image/png" {
			extension = "png"
		}
		v := storedAvatar{userAvatar: userAvatar{ID: avatarID, Name: strings.TrimSpace(str(input["name"])), Status: "submitting", CreatedAt: now()}, ObjectKey: "/keagent/" + digestBytes([]byte(a.UserID)) + "/avatars/" + avatarID + "." + extension, Hash: hash, Mime: mime, AuthorizedAt: now()}
		raw, _ := json.Marshal(v)
		inserted, err := s.db.ExecContext(ctx, `INSERT INTO keagent_user_avatar(id,owner_id,request_key,fingerprint,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT(owner_id,request_key) DO NOTHING`, v.ID, a.UserID, str(input["requestKey"]), fingerprint, raw)
		if err != nil {
			return nil, err
		}
		count, _ := inserted.RowsAffected()
		if count == 0 {
			var prior string
			var archived bool
			if err = s.db.QueryRowContext(ctx, `SELECT fingerprint,payload,archived FROM keagent_user_avatar WHERE owner_id=$1 AND request_key=$2`, a.UserID, str(input["requestKey"])).Scan(&prior, &raw, &archived); err != nil {
				return nil, err
			}
			if prior != fingerprint || archived {
				return nil, fail(409, "此请求已提交，请刷新形象列表后处理")
			}
			if err = json.Unmarshal(raw, &v); err != nil {
				return nil, err
			}
			return v.userAvatar, nil
		}
		_, uploadErr := s.privateObject(ctx, "PUT", v.ObjectKey, data, mime)
		v.Status = "ready"
		if uploadErr != nil {
			v.Status = "unknown"
			v.Error = "照片保存结果待核对，请刷新状态，勿重复上传"
		}
		checkpoint, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		if err = s.saveAvatarStatus(checkpoint, a.UserID, v); err != nil {
			return nil, err
		}
		return v.userAvatar, nil
	}
	v, err := s.ownedAvatar(ctx, a.UserID, str(input["id"]))
	if err != nil {
		return nil, err
	}
	switch operation {
	case "preview", "refresh":
		data, err := s.privateObject(ctx, "GET", v.ObjectKey, nil, "")
		if err != nil {
			if operation == "refresh" {
				v.Status = "unknown"
				v.Error = "照片尚未核对到，请稍后刷新或移除后重新上传"
				if saveErr := s.saveAvatarStatus(ctx, a.UserID, v); saveErr != nil {
					return nil, saveErr
				}
				return v.userAvatar, nil
			}
			return nil, err
		}
		if digestBytes(data) != v.Hash {
			return nil, fail(502, "本人照片校验失败，请联系管理员")
		}
		v.Status = "ready"
		v.Error = ""
		if err = s.saveAvatarStatus(ctx, a.UserID, v); err != nil {
			return nil, err
		}
		if operation == "preview" {
			return object{"photo": base64.StdEncoding.EncodeToString(data), "mime": v.Mime}, nil
		}
		return v.userAvatar, nil
	case "remove":
		if v.Status == "submitting" {
			return nil, fail(409, "照片正在上传，请先刷新状态")
		}
		_, err = s.db.ExecContext(ctx, `UPDATE keagent_user_avatar SET archived=true WHERE id=$1 AND owner_id=$2`, v.ID, a.UserID)
		return object{"removed": err == nil}, err
	}
	return nil, fail(404, "形象操作不存在")
}
