// Adapted from AutoUp-On 510132af0462a2bccd421ae264a7edab3a393982.
package main

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/quotedprintable"
	"net"
	"net/mail"
	"net/smtp"
	"strconv"
	"strings"
	"time"
)

type DouyinSMTPConfig struct {
	Host     string
	Port     int
	Username string
	Password string
	From     string
	TLSMode  string
	Timeout  time.Duration
}

type DouyinSMTPMailer struct {
	host     string
	address  string
	username string
	password string
	from     *mail.Address
	tlsMode  string
	timeout  time.Duration
}

func NewDouyinSMTPMailer(config DouyinSMTPConfig) (*DouyinSMTPMailer, error) {
	if strings.TrimSpace(config.Host) == "" || config.Port < 1 || config.Port > 65535 {
		return nil, errors.New("valid SMTP host and port are required")
	}
	if (config.Username == "") != (config.Password == "") {
		return nil, errors.New("SMTP username and password must be set together")
	}
	from, err := mail.ParseAddress(config.From)
	if err != nil || from.Address == "" {
		return nil, errors.New("valid SMTP from address is required")
	}
	if strings.ContainsAny(from.Address, "\r\n") {
		return nil, errors.New("invalid SMTP from address")
	}
	if config.TLSMode != "starttls" && config.TLSMode != "implicit" && config.TLSMode != "none" {
		return nil, errors.New("SMTP TLS mode must be starttls, implicit, or none")
	}
	if config.Timeout <= 0 {
		config.Timeout = 10 * time.Second
	}
	return &DouyinSMTPMailer{
		host: config.Host, address: net.JoinHostPort(config.Host, strconv.Itoa(config.Port)),
		username: config.Username, password: config.Password, from: from,
		tlsMode: config.TLSMode, timeout: config.Timeout,
	}, nil
}

func (m *DouyinSMTPMailer) Send(ctx context.Context, to, subject, body string) error {
	toAddress, err := mail.ParseAddress(to)
	if err != nil || toAddress.Address != to || strings.ContainsAny(to, "\r\n") {
		return errors.New("invalid SMTP recipient")
	}
	deadline := time.Now().Add(m.timeout)
	if contextDeadline, ok := ctx.Deadline(); ok && contextDeadline.Before(deadline) {
		deadline = contextDeadline
	}
	dialer := &net.Dialer{Deadline: deadline}
	var connection net.Conn
	if m.tlsMode == "implicit" {
		connection, err = (&tls.Dialer{
			NetDialer: dialer,
			Config:    &tls.Config{ServerName: m.host, MinVersion: tls.VersionTLS12},
		}).DialContext(ctx, "tcp", m.address)
	} else {
		connection, err = dialer.DialContext(ctx, "tcp", m.address)
	}
	if err != nil {
		return fmt.Errorf("connect to SMTP server: %w", err)
	}
	defer connection.Close()
	if err := connection.SetDeadline(deadline); err != nil {
		return fmt.Errorf("set SMTP deadline: %w", err)
	}
	client, err := smtp.NewClient(connection, m.host)
	if err != nil {
		return fmt.Errorf("start SMTP client: %w", err)
	}
	defer client.Close()

	if m.tlsMode == "starttls" {
		if ok, _ := client.Extension("STARTTLS"); !ok {
			return errors.New("SMTP server does not support required STARTTLS")
		}
		if err := client.StartTLS(&tls.Config{ServerName: m.host, MinVersion: tls.VersionTLS12}); err != nil {
			return fmt.Errorf("start SMTP TLS: %w", err)
		}
	}
	if m.username != "" {
		if err := client.Auth(smtp.PlainAuth("", m.username, m.password, m.host)); err != nil {
			return fmt.Errorf("authenticate SMTP client: %w", err)
		}
	}
	if err := client.Mail(m.from.Address); err != nil {
		return fmt.Errorf("set SMTP sender: %w", err)
	}
	if err := client.Rcpt(toAddress.Address); err != nil {
		return fmt.Errorf("set SMTP recipient: %w", err)
	}
	var message strings.Builder
	message.WriteString(strings.Join([]string{
		"From: " + m.from.String(),
		"To: " + (&mail.Address{Address: toAddress.Address}).String(),
		"Subject: " + mime.QEncoding.Encode("UTF-8", subject),
		"Date: " + time.Now().Format(time.RFC1123Z),
		"MIME-Version: 1.0",
		"Content-Type: text/html; charset=UTF-8",
		"Content-Transfer-Encoding: quoted-printable",
		"",
	}, "\r\n"))
	message.WriteString("\r\n")
	bodyWriter := quotedprintable.NewWriter(&message)
	if _, err := bodyWriter.Write([]byte(body)); err != nil {
		return fmt.Errorf("encode SMTP message: %w", err)
	}
	if err := bodyWriter.Close(); err != nil {
		return fmt.Errorf("finish SMTP encoding: %w", err)
	}

	writer, err := client.Data()
	if err != nil {
		return fmt.Errorf("start SMTP message: %w", err)
	}
	if _, err := io.WriteString(writer, message.String()); err != nil {
		writer.Close()
		return fmt.Errorf("write SMTP message: %w", err)
	}
	if err := writer.Close(); err != nil {
		return fmt.Errorf("finish SMTP message: %w", err)
	}
	if err := client.Quit(); err != nil {
		return fmt.Errorf("finish SMTP session: %w", err)
	}
	return nil
}
