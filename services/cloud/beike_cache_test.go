package main

import (
	"testing"
	"time"
)

func TestBeikeCache(t *testing.T) {
	c := &beikeCache{ttl: time.Minute, max: 2, items: map[string]beikeCacheItem{}}
	if _, ok := c.get("missing"); ok {
		t.Fatal("empty cache hit")
	}
	c.put("a", []byte("1"))
	if v, ok := c.get("a"); !ok || string(v) != "1" {
		t.Fatalf("cache miss after put: %q %v", v, ok)
	}
	c.items["expired"] = beikeCacheItem{value: []byte("2"), expiresAt: time.Now().Add(-time.Second)}
	if _, ok := c.get("expired"); ok {
		t.Fatal("expired entry returned")
	}
	c.put("x", []byte("3"))
	c.put("y", []byte("4"))
	c.put("z", []byte("5"))
	if len(c.items) > 2 {
		t.Fatalf("cache exceeded max: %d", len(c.items))
	}
	disabled := &beikeCache{ttl: 0, max: 10, items: map[string]beikeCacheItem{}}
	disabled.put("a", []byte("1"))
	if _, ok := disabled.get("a"); ok {
		t.Fatal("disabled cache returned entry")
	}
}
