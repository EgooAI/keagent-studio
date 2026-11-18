package main

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestVoicePreviewCacheCollapsesConcurrentMisses(t *testing.T) {
	var cache voicePreviewCache
	var calls atomic.Int32
	var wg sync.WaitGroup
	started := make(chan struct{})
	release := make(chan struct{})
	for range 8 {
		wg.Go(func() {
			audio, err := cache.load(t.Context(), "same-preview", time.Minute, func() (string, error) {
				if calls.Add(1) == 1 {
					close(started)
				}
				<-release
				return "audio", nil
			})
			if err != nil || audio != "audio" {
				t.Errorf("bad preview: %s %v", audio, err)
			}
		})
	}
	<-started
	close(release)
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatalf("synthesized %d previews, want 1", calls.Load())
	}
	cache.entries["same-preview"] = voicePreviewEntry{audio: "old", expires: time.Now().Add(-time.Second)}
	for range 2 {
		_, _ = cache.load(t.Context(), "same-preview", time.Minute, func() (string, error) {
			calls.Add(1)
			return "", errors.New("provider failed")
		})
	}
	if calls.Load() != 3 {
		t.Fatalf("expired preview or failed synthesis was reused, model calls: %d", calls.Load())
	}
}

func TestVoicePreviewCacheScopesAndTracksTheProvider(t *testing.T) {
	s := voiceTestServer(t)
	if err := seedDefaultPublicVoice(t.Context(), s.db); err != nil {
		t.Fatal(err)
	}
	var calls int
	s.speech = func(context.Context, string, object, string) ([]byte, error) {
		calls++
		return []byte(qwenSpeechFixture), nil
	}
	public := func(a actor) {
		t.Helper()
		if _, err := s.previewPublicVoice(t.Context(), a, defaultPublicVoiceID); err != nil {
			t.Fatal(err)
		}
	}
	public(actor{UserID: "a"})
	public(actor{UserID: "b"})
	if calls != 1 {
		t.Fatalf("public preview wasn't shared: %d calls", calls)
	}
	t.Setenv("DASHSCOPE_API_KEY", "server-rotated-test-key")
	public(actor{UserID: "a"})
	for _, owner := range []string{"a", "a", "b"} {
		if _, err := s.previewSynthesizedVoice(t.Context(), actor{UserID: owner}, owner,
			"example-voice", "zh-CN", "longanlingxin_v3.1", qwenAudioModel); err != nil {
			t.Fatal(err)
		}
	}
	if calls != 4 {
		t.Fatalf("new config or personal scope incorrectly shared a preview: %d calls", calls)
	}
}
