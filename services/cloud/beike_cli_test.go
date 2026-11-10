package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestBeikeCLIArgs(t *testing.T) {
	for _, tc := range []struct {
		operation string
		value     string
		want      []string
	}{
		{"search", "1000万以内，两居", []string{"--query", "在售二手房，1000万以内，两居", "--house-type", "second", "--json"}},
		{"search", "在售二手房，两居", []string{"--query", "在售二手房，两居", "--house-type", "second", "--json"}},
		{"detail", "ID-01", []string{"--id", "ID-01", "--entity-type", "house", "--json"}},
		{"material", "ID-01", []string{"--id", "ID-01", "--entity-type", "house", "--json"}},
	} {
		args, err := beikeCLIArgs(tc.operation, " 北京 ", tc.value)
		want := append([]string{"buy", tc.operation, "--city", "北京"}, tc.want...)
		if err != nil || !slices.Equal(args, want) {
			t.Fatalf("got %q, %v; want %q", args, err, want)
		}
	}
	for _, tc := range [][3]string{
		{"Search", "北京", "两居"}, {"contact", "北京", "ID"},
		{"search", "--help", "两居"}, {"material", "北京", ""},
		{"search", "北京", "--在售二手房"}, {"search", "北京", "在售二手房\n两居"},
		{"detail", "北京", "ID1,ID2"}, {"material", "北京", "--pretty"},
	} {
		if args, err := beikeCLIArgs(tc[0], tc[1], tc[2]); err == nil {
			t.Fatalf("accepted %q: %q", tc, args)
		}
	}
	if _, err := runBeikeCLI(t.Context(), "beike.exe", "test", "search", "北京", "两居"); err == nil {
		t.Fatal("relative executable path accepted")
	}
}

func TestBeikeCLIOutput(t *testing.T) {
	const good = "{\n  \"ok\": true,\n  \"data\": \"{\\\"synthetic\\\":[]}\"\n}"
	const rejected = `{"error":"invalid cli request","ok":false}`
	for _, tc := range []struct {
		name, stdout string
		want         error
	}{
		{"one", good + "\n", nil},
		{"duplicate", good + "\n\n" + good + "\n", nil},
		{"duplicate CRLF", good + "\r\n\r\n" + good + "\r\n", nil},
		{"duplicate rejection", rejected + "\n\n" + rejected, errBeikeCLIRejected},
		{"business error", `{"ok":false,"error":"secret upstream message"}`, errBeikeCLIBusiness},
		{"stderr text on stdout", "diagnostic\n" + good, errBeikeCLIInvalidOutput},
		{"wrong case", `{"OK":true,"data":[]}`, errBeikeCLIInvalidOutput},
		{"missing data", `{"ok":true}`, errBeikeCLIInvalidOutput},
		{"opaque null data for capture", `{"ok":true,"data":null}`, nil},
		{"duplicate status field", `{"ok":false,"ok":true,"data":[]}`, errBeikeCLIInvalidOutput},
		{"conflicting frames", good + "\n\n" + rejected, errBeikeCLIInvalidOutput},
		{"concatenated frames", good + good, errBeikeCLIInvalidOutput},
		{"extra frame", good + "\n\n" + good + "\n\n" + good, errBeikeCLIInvalidOutput},
		{"invalid UTF-8", "{\"ok\":true,\"data\":\"\xff\"}", errBeikeCLIInvalidOutput},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := validateBeikeCLIOutput([]byte(tc.stdout)); !errors.Is(err, tc.want) {
				t.Fatalf("got %v, want %v", err, tc.want)
			}
		})
	}
}

const beikeCLITestKey = "beike-runner-local-test-key"
const beikeCLITestFrame = "{\n  \"data\": \"synthetic fixture\",\n  \"ok\": true\n}"
const beikeCLITestStdout = beikeCLITestFrame + "\n\n" + beikeCLITestFrame + "\n"

func init() {
	if os.Getenv("BEIKE_MCP_API_KEY") != beikeCLITestKey || len(os.Args) != 10 || os.Args[1] != "buy" {
		return
	}
	if os.Getenv("BEIKE_MCP_BASE_URL") != "" || os.Getenv("AI_CONFIG_ENCRYPTION_KEY") != "" {
		os.Exit(2)
	}
	switch os.Args[6] {
	case "rejected":
		fmt.Fprintln(os.Stdout, `{"ok":false,"error":"invalid cli request"}`)
	case "credential":
		fmt.Fprintf(os.Stdout, `{"ok":true,"data":%q}`, beikeCLITestKey)
	case "process-error":
		fmt.Fprintln(os.Stderr, beikeCLITestKey)
		os.Exit(1)
	case "overflow":
		fmt.Fprint(os.Stderr, strings.Repeat("x", (64<<10)+1))
	case "timeout":
		time.Sleep(time.Minute)
	default:
		fmt.Fprint(os.Stdout, beikeCLITestStdout)
	}
	os.Exit(0)
}

func TestRunBeikeCLISubprocess(t *testing.T) {
	t.Setenv("BEIKE_MCP_BASE_URL", "https://unexpected.example")
	t.Setenv("AI_CONFIG_ENCRYPTION_KEY", "unrelated-config-key")
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := runBeikeCLI(t.Context(), executable, beikeCLITestKey, "detail", "北京", "success")
	if err != nil || string(stdout) != beikeCLITestStdout {
		t.Fatalf("capture changed or child environment leaked: %q, %v", stdout, err)
	}
	for id, want := range map[string]error{
		"rejected":      errBeikeCLIRejected,
		"credential":    errBeikeCLIInvalidOutput,
		"process-error": errBeikeCLIExecution,
		"overflow":      errBeikeCLIOutputLimit,
	} {
		stdout, err := runBeikeCLI(t.Context(), executable, beikeCLITestKey, "detail", "北京", id)
		if stdout != nil || !errors.Is(err, want) {
			t.Fatalf("case %q got stdout=%d bytes, error=%v; want %v", id, len(stdout), err, want)
		}
	}
	ctx, cancel := context.WithTimeout(t.Context(), 150*time.Millisecond)
	defer cancel()
	stdout, err = runBeikeCLI(ctx, executable, beikeCLITestKey, "detail", "北京", "timeout")
	if stdout != nil || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("timeout got stdout=%d bytes, error=%v", len(stdout), err)
	}
}
