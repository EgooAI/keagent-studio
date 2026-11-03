package main

import (
	"context"
	"crypto/ed25519"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

var errJWKSUnavailable = errors.New("JWKS unavailable")

type accessClaims struct {
	SessionID string `json:"sid"`
	jwt.RegisteredClaims
}

type jwtVerifier struct {
	issuer, audience, endpoint string
	client                     *http.Client
	mu                         sync.Mutex
	keys                       map[string]ed25519.PublicKey
	expires, lastAttempt       time.Time
}

func newJWTVerifier() (*jwtVerifier, error) {
	issuer := os.Getenv("JWT_ISSUER")
	if issuer == "" {
		issuer = os.Getenv("BETTER_AUTH_URL")
	}
	if issuer == "" {
		issuer = "http://127.0.0.1:18080"
	}
	endpoint := os.Getenv("JWKS_URL")
	if endpoint == "" {
		base := os.Getenv("BETTER_AUTH_URL")
		if base == "" {
			base = "http://127.0.0.1:18080"
		}
		endpoint = strings.TrimRight(base, "/") + "/api/auth/jwks"
	}
	u, err := url.Parse(endpoint)
	if err != nil || u.User != nil || u.Host == "" || u.Fragment != "" || (u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost" || u.Hostname() == "::1"))) {
		return nil, errors.New("JWKS_URL must use HTTPS or loopback HTTP")
	}
	audience := os.Getenv("JWT_AUDIENCE")
	if audience == "" {
		audience = "keagent-api"
	}
	return &jwtVerifier{issuer: issuer, audience: audience, endpoint: endpoint, client: &http.Client{
		Timeout:       3 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("JWKS redirect refused") },
	}}, nil
}

func (v *jwtVerifier) key(ctx context.Context, kid string) (ed25519.PublicKey, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	now := time.Now()
	if key := v.keys[kid]; key != nil && now.Before(v.expires) {
		return key, nil
	}
	// Unknown kids share a cooldown, so arbitrary tokens cannot flood the auth service.
	if now.Sub(v.lastAttempt) < 5*time.Second {
		if !now.Before(v.expires) {
			return nil, errJWKSUnavailable
		}
		return nil, errors.New("unknown kid")
	}
	v.lastAttempt = now
	req, err := http.NewRequestWithContext(ctx, "GET", v.endpoint, nil)
	if err != nil {
		return nil, errJWKSUnavailable
	}
	response, err := v.client.Do(req)
	if err != nil {
		return nil, errJWKSUnavailable
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
	if err != nil || response.StatusCode != http.StatusOK || len(data) > 1<<20 {
		return nil, errJWKSUnavailable
	}
	var jwks struct {
		Keys []struct{ Kid, Kty, Crv, Alg, Use, X string }
	}
	if json.Unmarshal(data, &jwks) != nil {
		return nil, errJWKSUnavailable
	}
	keys := make(map[string]ed25519.PublicKey)
	for _, key := range jwks.Keys {
		if key.Kid == "" || key.Kty != "OKP" || key.Crv != "Ed25519" || (key.Alg != "" && key.Alg != "EdDSA") || (key.Use != "" && key.Use != "sig") {
			continue
		}
		decoded, err := base64.RawURLEncoding.DecodeString(key.X)
		if err != nil || len(decoded) != ed25519.PublicKeySize || keys[key.Kid] != nil {
			return nil, errJWKSUnavailable
		}
		keys[key.Kid] = ed25519.PublicKey(decoded)
	}
	if len(keys) == 0 {
		return nil, errJWKSUnavailable
	}
	v.keys, v.expires = keys, now.Add(5*time.Minute)
	if key := keys[kid]; key != nil {
		return key, nil
	}
	return nil, errors.New("unknown kid")
}

func (v *jwtVerifier) verify(ctx context.Context, raw string) (accessClaims, error) {
	var claims accessClaims
	if len(raw) > 16384 {
		return claims, fail(401, "无效的 Access Token")
	}
	_, err := jwt.ParseWithClaims(raw, &claims, func(token *jwt.Token) (any, error) {
		kid, _ := token.Header["kid"].(string)
		if kid == "" || len(kid) > 256 {
			return nil, errors.New("invalid kid")
		}
		return v.key(ctx, kid)
	}, jwt.WithValidMethods([]string{"EdDSA"}), jwt.WithIssuer(v.issuer), jwt.WithAudience(v.audience), jwt.WithExpirationRequired(), jwt.WithIssuedAt(), jwt.WithLeeway(5*time.Second), jwt.WithStrictDecoding())
	if errors.Is(err, errJWKSUnavailable) {
		return claims, fail(503, "认证公钥暂不可用")
	}
	if err != nil || claims.Subject == "" || claims.SessionID == "" || claims.IssuedAt == nil || claims.ExpiresAt == nil || !claims.ExpiresAt.After(claims.IssuedAt.Time) || claims.ExpiresAt.Sub(claims.IssuedAt.Time) > 5*time.Minute {
		return claims, fail(401, "Access Token 无效或已过期")
	}
	return claims, nil
}

func (s *server) authenticate(r *http.Request, body []byte) (actor, error) {
	if _, present := r.Header["Authorization"]; !present {
		return s.verify(r, body)
	}
	var a actor
	parts := strings.Fields(r.Header.Get("Authorization"))
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") || s.jwt == nil {
		return a, fail(401, "请使用 Access Token 登录")
	}
	claims, err := s.jwt.verify(r.Context(), parts[1])
	if err != nil {
		return a, err
	}
	a.UserID, a.SessionID, a.DeviceID = claims.Subject, claims.SessionID, r.Header.Get("X-Keagent-Device")
	// Signature checks are stateless; revocation and current permissions deliberately are not.
	err = s.db.QueryRowContext(r.Context(), `SELECT u.name, u.email, COALESCE(u.role,'user') FROM "session" s JOIN "user" u ON u.id=s."userId" WHERE s.id=$1 AND s."userId"=$2 AND s."expiresAt">now() AND (NOT COALESCE(u.banned,false) OR u."banExpires"<=now())`, a.SessionID, a.UserID).Scan(&a.Name, &a.Email, &a.Role)
	if errors.Is(err, sql.ErrNoRows) {
		return actor{}, fail(401, "会话已失效，请重新登录")
	}
	if err != nil {
		return actor{}, fail(503, "身份状态暂不可用")
	}
	return a, nil
}

func (s *server) cors(w http.ResponseWriter, r *http.Request) bool {
	w.Header().Add("Vary", "Origin")
	origin := r.Header.Get("Origin")
	if origin != "" {
		allowed := false
		for _, candidate := range s.origins {
			if origin == strings.TrimSpace(candidate) {
				allowed = true
				break
			}
		}
		if !allowed {
			respond(w, nil, fail(403, "请求来源无效"))
			return false
		}
		w.Header().Set("Access-Control-Allow-Origin", origin)
	}
	if r.Method == "OPTIONS" {
		if origin == "" || (r.Header.Get("Access-Control-Request-Method") != "GET" && r.Header.Get("Access-Control-Request-Method") != "POST") {
			respond(w, nil, fail(403, "跨域请求无效"))
			return false
		}
		for _, header := range strings.Split(r.Header.Get("Access-Control-Request-Headers"), ",") {
			switch strings.ToLower(strings.TrimSpace(header)) {
			case "", "authorization", "content-type", "x-keagent-device":
			default:
				respond(w, nil, fail(403, "跨域请求头无效"))
				return false
			}
		}
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Keagent-Device")
		w.Header().Set("Access-Control-Max-Age", "300")
		w.WriteHeader(http.StatusNoContent)
		return false
	}
	return true
}
