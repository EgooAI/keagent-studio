package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"time"
)

func douyinMailer() (*DouyinSMTPMailer, error) {
	port := 587
	if os.Getenv("DOUYIN_SMTP_PORT") != "" {
		var err error
		port, err = strconv.Atoi(os.Getenv("DOUYIN_SMTP_PORT"))
		if err != nil {
			return nil, err
		}
	}
	mode := os.Getenv("DOUYIN_SMTP_TLS")
	if mode == "" {
		mode = "starttls"
	}
	return NewDouyinSMTPMailer(DouyinSMTPConfig{Host: os.Getenv("DOUYIN_SMTP_HOST"), Port: port, Username: os.Getenv("DOUYIN_SMTP_USERNAME"), Password: os.Getenv("DOUYIN_SMTP_PASSWORD"), From: os.Getenv("DOUYIN_SMTP_FROM"), TLSMode: mode, Timeout: 10 * time.Second})
}
func douyinSMTPConfigured() bool { _, err := douyinMailer(); return err == nil }
func (s *server) douyinBackground(ctx context.Context) {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			_ = s.sweepDouyin(ctx)
			_ = s.deliverDouyinMail(ctx)
		}
	}
}
func (s *server) deliverDouyinMail(ctx context.Context) error {
	mailer, err := douyinMailer()
	if err != nil {
		return nil
	}
	var raw []byte
	if err = s.db.QueryRowContext(ctx, `SELECT payload FROM keagent_setting WHERE id='douyin-alerts'`).Scan(&raw); err == sql.ErrNoRows {
		return nil
	} else if err != nil {
		return err
	}
	var settings struct {
		OperationsEmail string `json:"operationsEmail"`
	}
	if err = json.Unmarshal(raw, &settings); err != nil {
		return err
	}
	if settings.OperationsEmail == "" {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var mailID, kind, recordID string
	err = tx.QueryRowContext(ctx, `SELECT id,kind,record_id FROM keagent_douyin_mail WHERE sent_at IS NULL AND next_at<=now() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`).Scan(&mailID, &kind, &recordID)
	if err == sql.ErrNoRows {
		return nil
	}
	if err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE keagent_douyin_mail SET attempts=attempts+1,next_at=now()+interval '5 minutes' WHERE id=$1`, mailID); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	subject := "抖音视频发布流程异常"
	body := "抖音短视频立即发布在24小时内连续3次执行失败，请在管理员端查看安全执行日志。"
	if kind == "recovery" {
		subject = "抖音视频发布流程恢复"
		body = "抖音短视频立即发布已收到一次明确的平台成功回执，流程故障计数已重置。"
	}
	body += "<br>发布记录：" + recordID
	if err = mailer.Send(ctx, settings.OperationsEmail, subject, body); err != nil {
		return fmt.Errorf("douyin alert delivery failed")
	}
	_, err = s.db.ExecContext(ctx, `UPDATE keagent_douyin_mail SET sent_at=now() WHERE id=$1 AND sent_at IS NULL`, mailID)
	return err
}
