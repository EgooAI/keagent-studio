package main

import (
	"slices"
	"testing"
)

func TestBeikeCallArgs(t *testing.T) {
	for _, tc := range []struct {
		name string
		req  beikeCallRequest
		want []string
	}{
		{
			"market",
			beikeCallRequest{Namespace: "buy", Command: "market", Args: map[string]beikeFlagValues{"city": {"北京"}, "query": {"望京走势"}}},
			[]string{"buy", "market", "--city", "北京", "--query", "望京走势"},
		},
		{
			"detail multi id",
			beikeCallRequest{Namespace: "buy", Command: "detail", Args: map[string]beikeFlagValues{"city": {"北京"}, "id": {"A", "B"}, "entity-type": {"house"}}},
			[]string{"buy", "detail", "--city", "北京", "--entity-type", "house", "--id", "A", "--id", "B"},
		},
		{
			"map geo",
			beikeCallRequest{Namespace: "map", Command: "geo", Args: map[string]beikeFlagValues{"address": {"望京SOHO"}}},
			[]string{"map", "geo", "--address", "望京SOHO"},
		},
	} {
		args, err := beikeCallArgs(tc.req)
		if err != nil || !slices.Equal(args, tc.want) {
			t.Fatalf("%s: got %q, %v; want %q", tc.name, args, err, tc.want)
		}
	}
	for _, req := range []beikeCallRequest{
		{Namespace: "unknown", Command: "search"},
		{Namespace: "buy", Command: "unknown"},
		{Namespace: "buy", Command: "market", Args: map[string]beikeFlagValues{"bad-flag": {"x"}}},
		{Namespace: "buy", Command: "market", Args: map[string]beikeFlagValues{"query": {"-help"}}},
	} {
		if args, err := beikeCallArgs(req); err == nil {
			t.Fatalf("accepted %+v: %q", req, args)
		}
	}
}
