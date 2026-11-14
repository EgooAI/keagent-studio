package main

import (
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// beikeCache 缓存贝壳 CLI 的成功输出，避免短时间内对同一查询重复 spawn 子进程。
// TTL 由 BEIKE_CLI_CACHE_TTL（秒）配置，0 表示禁用；条目上限由 BEIKE_CLI_CACHE_MAX 配置。
// 房源数据变化慢，短 TTL 缓存（默认 5 分钟）在「请求量大」场景能显著降低对贝壳的外呼。
type beikeCache struct {
	mu    sync.Mutex
	ttl   time.Duration
	max   int
	items map[string]beikeCacheItem
}

type beikeCacheItem struct {
	value     []byte
	expiresAt time.Time
}

var beikeCacheStore = newBeikeCache()

func newBeikeCache() *beikeCache {
	ttl := 5 * time.Minute
	if v := strings.TrimSpace(os.Getenv("BEIKE_CLI_CACHE_TTL")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			ttl = time.Duration(n) * time.Second
		}
	}
	max := 1024
	if v := strings.TrimSpace(os.Getenv("BEIKE_CLI_CACHE_MAX")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			max = n
		}
	}
	return &beikeCache{ttl: ttl, max: max, items: map[string]beikeCacheItem{}}
}

func (c *beikeCache) get(key string) ([]byte, bool) {
	if c.ttl == 0 {
		return nil, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	item, ok := c.items[key]
	if !ok {
		return nil, false
	}
	if time.Now().After(item.expiresAt) {
		delete(c.items, key)
		return nil, false
	}
	return item.value, true
}

func (c *beikeCache) put(key string, value []byte) {
	if c.ttl == 0 || len(value) > 1<<20 {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.items) >= c.max {
		now := time.Now()
		for k, item := range c.items {
			if now.After(item.expiresAt) {
				delete(c.items, k)
			}
		}
	}
	if len(c.items) >= c.max {
		for k := range c.items {
			delete(c.items, k)
			break
		}
	}
	c.items[key] = beikeCacheItem{value: value, expiresAt: time.Now().Add(c.ttl)}
}
