package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"mime/quotedprintable"
	"net"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestDouyinSMTPMailerSendsMessage(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	message := make(chan string, 1)
	serverError := make(chan error, 1)
	go serveDouyinTestSMTP(listener, message, serverError)

	port, _ := strconv.Atoi(strings.TrimPrefix(listener.Addr().String(), "127.0.0.1:"))
	mailer, err := NewDouyinSMTPMailer(DouyinSMTPConfig{
		Host: "127.0.0.1", Port: port, From: "AutoUp-On <noreply@autoup.local>",
		TLSMode: "none", Timeout: 2 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	const mailBody = `<p>验证码 Aa0Bb1</p>`
	if err := mailer.Send(context.Background(), "user@example.com", "验证邮箱", mailBody); err != nil {
		t.Fatal(err)
	}
	select {
	case body := <-message:
		if !strings.Contains(body, "Subject: =?UTF-8?") ||
			!strings.Contains(body, "Content-Type: text/html; charset=UTF-8") ||
			!strings.Contains(body, "Content-Transfer-Encoding: quoted-printable") {
			t.Fatalf("unexpected SMTP message: %s", body)
		}
		parts := strings.SplitN(body, "\r\n\r\n", 2)
		if len(parts) != 2 {
			t.Fatalf("SMTP message has no header/body separator: %s", body)
		}
		decoded, err := io.ReadAll(quotedprintable.NewReader(strings.NewReader(parts[1])))
		if err != nil || !strings.Contains(string(decoded), mailBody) {
			t.Fatalf("unexpected decoded SMTP body %q: %v", decoded, err)
		}
	case err := <-serverError:
		t.Fatal(err)
	case <-time.After(2 * time.Second):
		t.Fatal("SMTP test server did not receive a message")
	}
}

func serveDouyinTestSMTP(listener net.Listener, messages chan<- string, errors chan<- error) {
	connection, err := listener.Accept()
	if err != nil {
		errors <- err
		return
	}
	defer connection.Close()
	reader := bufio.NewReader(connection)
	writer := bufio.NewWriter(connection)
	respond := func(response string) error {
		if _, err := fmt.Fprintf(writer, "%s\r\n", response); err != nil {
			return err
		}
		return writer.Flush()
	}
	if err := respond("220 test SMTP"); err != nil {
		errors <- err
		return
	}
	var body strings.Builder
	inData := false
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			errors <- err
			return
		}
		trimmed := strings.TrimRight(line, "\r\n")
		if inData {
			if trimmed == "." {
				inData = false
				messages <- body.String()
				if err := respond("250 queued"); err != nil {
					errors <- err
					return
				}
				continue
			}
			body.WriteString(line)
			continue
		}
		switch {
		case strings.HasPrefix(trimmed, "EHLO"):
			err = respond("250 test")
		case strings.HasPrefix(trimmed, "MAIL FROM:"), strings.HasPrefix(trimmed, "RCPT TO:"):
			err = respond("250 ok")
		case trimmed == "DATA":
			inData = true
			err = respond("354 continue")
		case trimmed == "QUIT":
			err = respond("221 bye")
			if err != nil {
				errors <- err
			}
			return
		default:
			errors <- fmt.Errorf("unexpected SMTP command %q", trimmed)
			return
		}
		if err != nil {
			errors <- err
			return
		}
	}
}
