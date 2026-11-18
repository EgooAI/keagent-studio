package main

import (
	"context"
	"encoding/base64"
	"sync"
	"time"
)

const maxVoicePreviewEntries = 48
const maxVoicePreviewAudio = 1 << 20

type voicePreviewEntry struct {
	audio   string
	expires time.Time
}

type voicePreviewFlight struct {
	done  chan struct{}
	audio string
	err   error
}

type voicePreviewCache struct {
	mu      sync.Mutex
	entries map[string]voicePreviewEntry
	flights map[string]*voicePreviewFlight
}

func (cache *voicePreviewCache) load(ctx context.Context, key string, ttl time.Duration, synthesize func() (string, error)) (string, error) {
	cache.mu.Lock()
	if entry, found := cache.entries[key]; found && time.Now().Before(entry.expires) {
		cache.mu.Unlock()
		return entry.audio, nil
	}
	if pending := cache.flights[key]; pending != nil {
		cache.mu.Unlock()
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-pending.done:
			return pending.audio, pending.err
		}
	}
	if cache.flights == nil {
		cache.flights = make(map[string]*voicePreviewFlight)
	}
	pending := &voicePreviewFlight{done: make(chan struct{})}
	cache.flights[key] = pending
	cache.mu.Unlock()

	pending.audio, pending.err = synthesize()
	cache.mu.Lock()
	defer cache.mu.Unlock()
	defer close(pending.done)
	delete(cache.flights, key)
	if pending.err == nil && len(pending.audio) <= maxVoicePreviewAudio {
		if cache.entries == nil {
			cache.entries = make(map[string]voicePreviewEntry)
		}
		now := time.Now()
		var oldestKey string
		var oldest time.Time
		for id, entry := range cache.entries {
			if !now.Before(entry.expires) {
				delete(cache.entries, id)
			} else if oldestKey == "" || entry.expires.Before(oldest) {
				oldestKey, oldest = id, entry.expires
			}
		}
		if len(cache.entries) >= maxVoicePreviewEntries {
			delete(cache.entries, oldestKey)
		}
		cache.entries[key] = voicePreviewEntry{audio: pending.audio, expires: now.Add(ttl)}
	}
	return pending.audio, pending.err
}

func (s *server) previewSynthesizedVoice(ctx context.Context, a actor, owner, voiceID, language, speaker, resource string) (any, error) {
	if !qwenSpeechConfigured(ctx) {
		return nil, fail(503, "百炼配音服务尚未配置")
	}
	text := "您好，我是您的房产顾问，欢迎一起了解这套房源。"
	if language == "en-US" {
		text = "Hello, let me introduce this property to you."
	}
	key := digestBytes(mustJSON([]any{
		owner, voiceID, language, speaker, resource, text,
		aiSnapshotFrom(ctx).versions[speechAIGroup], aiValue(ctx, "DASHSCOPE_WORKSPACE_ID"),
		digestBytes([]byte(aiValue(ctx, "DASHSCOPE_API_KEY"))),
	}))
	ttl := 30 * time.Minute
	if owner != "" {
		ttl = 5 * time.Minute
	}
	audio, err := s.voicePreviews.load(ctx, key, ttl, func() (string, error) {
		providerCtx := s.withProviderUsageReference(ctx, a.UserID, "voice_preview", voiceID, "")
		result, err := s.synthesizePCM(providerCtx, language, text, speaker, resource, 1)
		if err != nil {
			return "", err
		}
		pcm, err := base64.StdEncoding.DecodeString(str(result.(object)["pcm"]))
		if err != nil {
			return "", err
		}
		return base64.StdEncoding.EncodeToString(pcmWAV(pcm)), nil
	})
	if err != nil {
		return nil, err
	}
	return object{"audio": audio, "mime": "audio/wav"}, nil
}
