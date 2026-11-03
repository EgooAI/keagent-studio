package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func testClaims() accessClaims {
	return accessClaims{SessionID: "session-a", RegisteredClaims: jwt.RegisteredClaims{
		Subject: "user-a", Issuer: "test-auth", Audience: jwt.ClaimStrings{"keagent-api"},
		IssuedAt: jwt.NewNumericDate(time.Now()), ExpiresAt: jwt.NewNumericDate(time.Now().Add(5 * time.Minute)),
	}}
}

func signAccess(t *testing.T, key ed25519.PrivateKey, claims accessClaims, kid string) string {
	t.Helper()
	token := jwt.NewWithClaims(jwt.SigningMethodEdDSA, claims)
	if kid != "" {
		token.Header["kid"] = kid
	}
	// These URLs must never become sources of verification keys.
	token.Header["jku"] = "http://attacker.invalid/jwks"
	raw, err := token.SignedString(key)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestAccessClaims(t *testing.T) {
	public, private, _ := ed25519.GenerateKey(rand.Reader)
	v := &jwtVerifier{issuer: "test-auth", audience: "keagent-api", keys: map[string]ed25519.PublicKey{"key-a": public}, expires: time.Now().Add(time.Minute)}
	if claims, err := v.verify(t.Context(), signAccess(t, private, testClaims(), "key-a")); err != nil || claims.Subject != "user-a" || claims.SessionID != "session-a" {
		t.Fatalf("valid token refused: %v", err)
	}
	for name, change := range map[string]func(*accessClaims){
		"issuer":           func(c *accessClaims) { c.Issuer = "other" },
		"audience":         func(c *accessClaims) { c.Audience = jwt.ClaimStrings{"other"} },
		"missing issuer":   func(c *accessClaims) { c.Issuer = "" },
		"missing audience": func(c *accessClaims) { c.Audience = nil },
		"expired":          func(c *accessClaims) { c.ExpiresAt = jwt.NewNumericDate(time.Now().Add(-time.Minute)) },
		"future iat":       func(c *accessClaims) { c.IssuedAt = jwt.NewNumericDate(time.Now().Add(time.Minute)) },
		"future nbf":       func(c *accessClaims) { c.NotBefore = jwt.NewNumericDate(time.Now().Add(time.Minute)) },
		"missing exp":      func(c *accessClaims) { c.ExpiresAt = nil },
		"missing iat":      func(c *accessClaims) { c.IssuedAt = nil },
		"missing sub":      func(c *accessClaims) { c.Subject = "" },
		"missing sid":      func(c *accessClaims) { c.SessionID = "" },
		"long lifetime":    func(c *accessClaims) { c.ExpiresAt = jwt.NewNumericDate(time.Now().Add(time.Hour)) },
	} {
		t.Run(name, func(t *testing.T) {
			claims := testClaims()
			change(&claims)
			if _, err := v.verify(t.Context(), signAccess(t, private, claims, "key-a")); err == nil {
				t.Fatal("invalid claims accepted")
			}
		})
	}
	_, other, _ := ed25519.GenerateKey(rand.Reader)
	for _, raw := range []string{signAccess(t, other, testClaims(), "key-a"), signAccess(t, private, testClaims(), ""), "bad.token", strings.Repeat("x", 16385)} {
		if _, err := v.verify(t.Context(), raw); err == nil {
			t.Fatal("invalid token accepted")
		}
	}
	for _, method := range []jwt.SigningMethod{jwt.SigningMethodNone, jwt.SigningMethodHS256} {
		token := jwt.NewWithClaims(method, testClaims())
		token.Header["kid"] = "key-a"
		var signingKey any = []byte(public)
		if method == jwt.SigningMethodNone {
			signingKey = jwt.UnsafeAllowNoneSignatureType
		}
		raw, err := token.SignedString(signingKey)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = v.verify(t.Context(), raw); err == nil {
			t.Fatal("algorithm confusion accepted")
		}
	}
}

func TestJWKSCacheRotationAndOutage(t *testing.T) {
	public, private, _ := ed25519.GenerateKey(rand.Reader)
	var calls atomic.Int32
	var unavailable atomic.Bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Path != "/api/auth/jwks" {
			t.Error("unexpected JWKS path")
		}
		if unavailable.Load() {
			w.WriteHeader(503)
			return
		}
		respond(w, object{"keys": []object{{"kid": "rotated", "kty": "OKP", "crv": "Ed25519", "alg": "EdDSA", "x": base64.RawURLEncoding.EncodeToString(public)}}}, nil)
	}))
	defer upstream.Close()
	t.Setenv("JWKS_URL", upstream.URL+"/api/auth/jwks")
	t.Setenv("JWT_ISSUER", "test-auth")
	t.Setenv("JWT_AUDIENCE", "keagent-api")
	v, err := newJWTVerifier()
	if err != nil {
		t.Fatal(err)
	}
	raw := signAccess(t, private, testClaims(), "rotated")
	var wg sync.WaitGroup
	for range 12 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := v.verify(t.Context(), raw); err != nil {
				t.Errorf("concurrent verify: %v", err)
			}
		}()
	}
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatal("concurrent JWKS refresh was not shared")
	}
	for range 10 {
		if _, err := v.key(t.Context(), "unknown"); err == nil {
			t.Fatal("unknown kid accepted")
		}
	}
	if calls.Load() != 1 {
		t.Fatal("unknown kids bypassed refresh cooldown")
	}
	// Simulate an old cached set; an unseen kid refreshes and replaces that set.
	v.mu.Lock()
	v.keys = map[string]ed25519.PublicKey{"old": public}
	v.lastAttempt = time.Now().Add(-time.Minute)
	v.mu.Unlock()
	if _, err := v.verify(t.Context(), raw); err != nil || calls.Load() != 2 {
		t.Fatalf("rotation not discovered: %v", err)
	}
	unavailable.Store(true)
	if _, err := v.verify(t.Context(), raw); err != nil {
		t.Fatalf("fresh cached key failed during auth outage: %v", err)
	}
	v.mu.Lock()
	v.expires = time.Now().Add(-time.Second)
	v.lastAttempt = time.Now().Add(-time.Minute)
	v.mu.Unlock()
	if _, err := v.verify(t.Context(), raw); err == nil {
		t.Fatal("expired cache accepted during auth outage")
	} else {
		var f fault
		if !errors.As(err, &f) || f.status != 503 {
			t.Fatalf("JWKS outage status: %v", err)
		}
	}
}

func TestJWKSRejectsBadResponses(t *testing.T) {
	for name, body := range map[string]string{
		"empty": `{"keys":[]}`, "malformed": `not json`,
		"bad key":     `{"keys":[{"kid":"a","kty":"OKP","crv":"Ed25519","x":"bad"}]}`,
		"wrong curve": `{"keys":[{"kid":"a","kty":"OKP","crv":"Ed448","x":"bad"}]}`,
		"oversized":   strings.Repeat(" ", (1<<20)+1),
	} {
		t.Run(name, func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(body)) }))
			defer upstream.Close()
			v := &jwtVerifier{endpoint: upstream.URL, client: upstream.Client()}
			if _, err := v.key(t.Context(), "a"); !errors.Is(err, errJWKSUnavailable) {
				t.Fatalf("bad JWKS accepted: %v", err)
			}
		})
	}
	t.Setenv("JWKS_URL", "http://external.invalid/jwks")
	if _, err := newJWTVerifier(); err == nil {
		t.Fatal("external plaintext JWKS accepted")
	}
}

func TestCORSAndNoLegacyFallback(t *testing.T) {
	s := &server{origins: []string{"http://127.0.0.1:5174"}}
	for _, tc := range []struct {
		origin, method, headers string
		status                  int
	}{
		{"http://127.0.0.1:5174", "POST", "authorization, content-type, x-keagent-device", 204},
		{"http://evil.invalid", "GET", "authorization", 403},
		{"null", "GET", "authorization", 403},
		{"http://127.0.0.1:5174", "DELETE", "authorization", 403},
		{"http://127.0.0.1:5174", "POST", "x-keagent-context", 403},
	} {
		r := httptest.NewRequest("OPTIONS", "/v1/workspace", nil)
		r.Header.Set("Origin", tc.origin)
		r.Header.Set("Access-Control-Request-Method", tc.method)
		r.Header.Set("Access-Control-Request-Headers", tc.headers)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != tc.status || w.Header().Get("Access-Control-Allow-Credentials") != "" {
			t.Fatalf("CORS result: %d %v", w.Code, w.Header())
		}
	}
	r := httptest.NewRequest("GET", "/v1/workspace", nil)
	r.Header.Set("X-Keagent-Context", "forged-admin")
	for _, authorization := range []string{"", "Bearer invalid", "Basic invalid"} {
		r.Header.Set("Authorization", authorization)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != 401 {
			t.Fatalf("forged direct identity accepted: %d", w.Code)
		}
	}
}

func TestIdentityDatabaseFailureIsClosed(t *testing.T) {
	public, private, _ := ed25519.GenerateKey(rand.Reader)
	db, err := sql.Open("pgx", "postgres://unused")
	if err != nil {
		t.Fatal(err)
	}
	_ = db.Close()
	s := &server{db: db, jwt: &jwtVerifier{issuer: "test-auth", audience: "keagent-api", keys: map[string]ed25519.PublicKey{"key-a": public}, expires: time.Now().Add(time.Minute)}}
	r := httptest.NewRequest("GET", "/v1/workspace", nil)
	r.Header.Set("Authorization", "Bearer "+signAccess(t, private, testClaims(), "key-a"))
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 503 {
		t.Fatalf("database failure must fail closed: %d", w.Code)
	}
}
