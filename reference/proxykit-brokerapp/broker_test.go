package brokerapp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type dispatchFunc func(context.Context, Attempt) (AttemptResult, error)

func (f dispatchFunc) Dispatch(ctx context.Context, a Attempt) (AttemptResult, error) {
	return f(ctx, a)
}

func account(id, endpoint, caller string) Account {
	return Account{ID: id, Label: "Personal usage", Callers: []string{caller}, Endpoint: endpoint, Provider: "example", Model: "served-model", Credential: Credential{Token: "synthetic-" + id, Expires: time.Now().Add(time.Hour)}, Active: true}
}
func openStore(t *testing.T) *Store {
	t.Helper()
	s, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return s
}
func activate(t *testing.T, s *Store, a Account) {
	t.Helper()
	if err := s.Activate(a); err != nil {
		t.Fatal(err)
	}
}
func broker(t *testing.T, s *Store, cfg Config) *Broker {
	t.Helper()
	if cfg.CallerTokens == nil {
		cfg.CallerTokens = map[string]string{"synthetic-caller-a": "example-a", "synthetic-caller-b": "example-b"}
	}
	if cfg.AllowedEndpoints == nil {
		cfg.AllowedEndpoints = []string{"http://localhost/a", "http://localhost/b"}
	}
	b, err := New(s, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := b.Close(ctx); err != nil {
			t.Error(err)
		}
	})
	return b
}
func request(token string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "http://gateway/infer", nil)
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	return r
}
func okDispatch(_ context.Context, _ Attempt) (AttemptResult, error) {
	return AttemptResult{Status: 200}, nil
}

func TestIdentityAccountIsolationAndLocalUpstreams(t *testing.T) {
	var hits atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		id := strings.TrimPrefix(r.URL.Path, "/")
		if r.Header.Get("Authorization") != "Bearer synthetic-"+id || r.Header.Get("X-Caller-ID") != "" {
			t.Error("incorrect credential binding or inherited identity header")
		}
		w.WriteHeader(200)
	}))
	defer upstream.Close()
	s := openStore(t)
	a := account("a", upstream.URL+"/a", "example-a")
	c := account("b", upstream.URL+"/b", "example-b")
	c.Label = "Work laptop"
	c.Model = "another-model"
	activate(t, s, a)
	activate(t, s, c)
	b := broker(t, s, Config{AllowedEndpoints: []string{a.Endpoint, c.Endpoint}})
	d := dispatchFunc(func(ctx context.Context, a Attempt) (AttemptResult, error) {
		// Test managed bridge: build a fresh request, never clone caller auth.
		r, err := http.NewRequestWithContext(ctx, http.MethodPost, a.Endpoint, nil)
		if err != nil {
			return AttemptResult{}, err
		}
		r.Header.Set("Authorization", "Bearer "+a.Credential.Token)
		client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
		resp, err := client.Do(r)
		if err != nil {
			return AttemptResult{}, err
		}
		defer resp.Body.Close()
		_, _ = io.Copy(io.Discard, resp.Body)
		return AttemptResult{Status: resp.StatusCode, Usage: &Usage{InputTokens: 7, OutputTokens: 2}}, nil
	})
	for _, tc := range []struct{ token, id, model string }{{"synthetic-caller-a", "a", "served-model"}, {"synthetic-caller-b", "b", "another-model"}} {
		r := request(tc.token)
		r.Header.Set("X-Caller-ID", "example-b")
		r.Header.Set("X-Account-ID", "b")
		_, out, err := b.Execute(r, "requested-model", 2, d)
		if err != nil || len(out) != 1 || out[0].AccountID != tc.id || out[0].ServedModel != tc.model || out[0].RequestedModel != "requested-model" || out[0].Usage.InputTokens != 7 {
			t.Fatalf("wrong request-local outcome: %#v %v", out, err)
		}
	}
	for _, token := range []string{"", "invalid", "example-a"} {
		_, _, err := b.Execute(request(token), "model", 1, d)
		if !errors.Is(err, ErrAuth) {
			t.Fatal("accepted untrusted identity")
		}
	}
	r := request("synthetic-caller-a")
	r.Header.Add("Authorization", "Bearer synthetic-caller-b")
	if _, _, err := b.Execute(r, "model", 1, d); !errors.Is(err, ErrAuth) {
		t.Fatal("accepted ambiguous authentication")
	}
	if hits.Load() != 2 {
		t.Fatal("unauthenticated upstream call")
	}
}

func TestFallbackRechecksACLAndDestination(t *testing.T) {
	for _, mode := range []string{"allowed", "revoked", "denied-destination"} {
		t.Run(mode, func(t *testing.T) {
			s := openStore(t)
			a := account("a", "http://localhost/a", "example-a")
			c := account("b", "http://localhost/b", "example-a")
			activate(t, s, a)
			activate(t, s, c)
			b := broker(t, s, Config{})
			calls := 0
			d := dispatchFunc(func(_ context.Context, attempt Attempt) (AttemptResult, error) {
				calls++
				if calls == 1 {
					if mode == "revoked" {
						c.Callers = []string{"example-b"}
						activate(t, s, c)
					}
					if mode == "denied-destination" {
						c.Endpoint = "http://localhost/not-allowed"
						activate(t, s, c)
					}
					return AttemptResult{Status: 503, Usage: &Usage{InputTokens: 3}}, nil
				}
				if attempt.AccountID != "b" || attempt.Endpoint != c.Endpoint || attempt.Credential.Token != "synthetic-b" {
					t.Fatal("fallback binding mismatch")
				}
				return AttemptResult{Status: 200}, nil
			})
			_, out, err := b.Execute(request("synthetic-caller-a"), "requested", 2, d)
			if mode == "allowed" {
				if err != nil || calls != 2 || len(out) != 2 || out[1].Usage != nil {
					t.Fatal("authorized fallback failed")
				}
			} else if !errors.Is(err, ErrDenied) || calls != 1 {
				t.Fatal("fallback bypassed current policy")
			}
			if len(out) == 0 || out[0].Usage.InputTokens != 3 {
				t.Fatal("lost failed-attempt usage")
			}
		})
	}
}

func TestRefreshSingleflightAndWaiterCancellation(t *testing.T) {
	s := openStore(t)
	a := account("a", "http://localhost/a", "example-a")
	a.Credential.Expires = time.Now().Add(-time.Hour)
	activate(t, s, a)
	started := make(chan struct{})
	release := make(chan struct{})
	var refreshes atomic.Int32
	b := broker(t, s, Config{Refresh: func(ctx context.Context, id string, old Credential) (Credential, error) {
		if id != "a" || old.Token != "synthetic-a" {
			t.Error("wrong refresh account")
		}
		if refreshes.Add(1) == 1 {
			close(started)
		}
		select {
		case <-release:
			return Credential{Token: "synthetic-refreshed", Expires: time.Now().Add(time.Hour)}, nil
		case <-ctx.Done():
			return Credential{}, ctx.Err()
		}
	}})
	ctx, cancel := context.WithCancel(context.Background())
	r := request("synthetic-caller-a").WithContext(ctx)
	canceled := make(chan error, 1)
	go func() { _, _, err := b.Execute(r, "model", 1, dispatchFunc(okDispatch)); canceled <- err }()
	<-started
	const n = 40
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _, err := b.Execute(request("synthetic-caller-a"), "model", 1, dispatchFunc(func(_ context.Context, a Attempt) (AttemptResult, error) {
				if a.Credential.Token != "synthetic-refreshed" {
					t.Error("stale credential")
				}
				return AttemptResult{Status: 200}, nil
			}))
			if err != nil {
				t.Error(err)
			}
		}()
	}
	cancel()
	if err := <-canceled; !errors.Is(err, context.Canceled) {
		t.Fatal("waiter did not cancel independently")
	}
	close(release)
	wg.Wait()
	if refreshes.Load() != 1 {
		t.Fatalf("refresh calls=%d", refreshes.Load())
	}
	reopened, err := OpenStore(filepath.Dir(s.path))
	if err != nil || reopened.snapshot().Accounts["a"].Credential.Token != "synthetic-refreshed" {
		t.Fatal("refresh not persisted")
	}
}

func TestRefreshCannotOverwriteConcurrentRevocation(t *testing.T) {
	s := openStore(t)
	a := account("a", "http://localhost/a", "example-a")
	a.Credential.Expires = time.Time{}
	activate(t, s, a)
	b := broker(t, s, Config{Refresh: func(context.Context, string, Credential) (Credential, error) {
		a.Active = false
		activate(t, s, a)
		return Credential{Token: "synthetic-new", Expires: time.Now().Add(time.Hour)}, nil
	}})
	_, _, err := b.Execute(request("synthetic-caller-a"), "model", 1, dispatchFunc(func(context.Context, Attempt) (AttemptResult, error) {
		t.Error("dispatched after revocation")
		return AttemptResult{}, nil
	}))
	if !errors.Is(err, ErrRefresh) || s.snapshot().Accounts["a"].Active {
		t.Fatal("refresh overwrote policy")
	}
}

func TestActivationFailureAndUncertainCommit(t *testing.T) {
	for _, afterRename := range []bool{false, true} {
		t.Run(fmt.Sprint(afterRename), func(t *testing.T) {
			s := openStore(t)
			activate(t, s, account("a", "http://localhost/a", "example-a"))
			s.persist = func(path string, data []byte) error {
				if afterRename {
					if err := atomicFile(path, data); err != nil {
						return err
					}
				}
				return errors.New("synthetic write failure")
			}
			if err := s.Activate(account("b", "http://localhost/b", "example-b")); !errors.Is(err, ErrStore) {
				t.Fatal("expected commit failure")
			}
			b := broker(t, s, Config{})
			_, out, err := b.Execute(request("synthetic-caller-b"), "model", 1, dispatchFunc(okDispatch))
			if !errors.Is(err, ErrStore) || len(out) != 0 {
				t.Fatal("published uncertain activation")
			}
			var delivered atomic.Int32
			b.notify = func(context.Context, Notification) error { delivered.Add(1); return nil }
			if err := b.FlushNotifications(context.Background()); !errors.Is(err, ErrStore) {
				t.Fatal("uncertain store did not report failure")
			}
			if delivered.Load() != 0 {
				t.Fatal("published uncertain outbox")
			}
			// Reopen represents recovery: old transaction or new transaction, never half.
			recovered, err := OpenStore(filepath.Dir(s.path))
			if err != nil {
				t.Fatal(err)
			}
			state := recovered.snapshot()
			_, exists := state.Accounts["b"]
			if exists != afterRename {
				t.Fatal("unexpected recovered transaction")
			}
			want := 1
			if afterRename {
				want = 2
			}
			if len(state.Outbox) != want || len(state.Accounts) != want {
				t.Fatal("partial transaction recovered")
			}
		})
	}
}

func TestCatalogQuotaIsNotUsage(t *testing.T) {
	s := openStore(t)
	activate(t, s, account("a", "http://localhost/a", "example-a"))
	activate(t, s, account("b", "http://localhost/b", "example-b"))
	b := broker(t, s, Config{})
	b.UpdateQuota("a", QuotaSnapshot{Remaining: 42, ObservedAt: time.Now()})
	r := httptest.NewRequest("GET", "http://gateway/catalog?caller=example-b", nil)
	r.Header.Set("Authorization", "Bearer synthetic-caller-a")
	r.Header.Set("X-Caller-ID", "example-b")
	w := httptest.NewRecorder()
	b.CatalogHandler().ServeHTTP(w, r)
	var entries []CatalogEntry
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &entries) != nil || len(entries) != 1 || entries[0].ID != "a" || entries[0].Quota.Remaining != 42 {
		t.Fatal("catalog ACL/quota mismatch")
	}
	for _, secret := range []string{"synthetic-", "localhost", "credential", "callers"} {
		if strings.Contains(w.Body.String(), secret) {
			t.Fatal("catalog disclosed private account data")
		}
	}
	_, out, err := b.Execute(request("synthetic-caller-a"), "model", 1, dispatchFunc(okDispatch))
	if err != nil || out[0].Usage != nil {
		t.Fatal("quota substituted for unknown usage")
	}
	w = httptest.NewRecorder()
	b.CatalogHandler().ServeHTTP(w, httptest.NewRequest("GET", "http://gateway/catalog", nil))
	if w.Code != 401 {
		t.Fatal("unauthenticated catalog")
	}
}

func listener(t *testing.T) net.Listener {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	return l
}

func TestEnrollmentAuthSeparateListenerAndLifecycle(t *testing.T) {
	s := openStore(t)
	b := broker(t, s, Config{})
	catalog, enrollment := listener(t), listener(t)
	app, err := Start(b, catalog, enrollment, "synthetic-service", 10*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := app.Close(ctx); err != nil {
			t.Error(err)
		}
	})
	client := &http.Client{Timeout: time.Second}
	a := account("a", "http://localhost/a", "example-a")
	body, _ := json.Marshal(a)
	send := func(base, path, token string, data []byte) int {
		r, _ := http.NewRequest("POST", "http://"+base+path, bytes.NewReader(data))
		r.Header.Set("Authorization", "Bearer "+token)
		resp, err := client.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		_, _ = io.Copy(io.Discard, resp.Body)
		return resp.StatusCode
	}
	for _, token := range []string{"", "synthetic-caller-a", "wrong"} {
		if send(enrollment.Addr().String(), "/enroll", token, body) != 401 {
			t.Fatal("enrollment service auth bypass")
		}
	}
	if len(s.snapshot().Accounts) != 0 {
		t.Fatal("unauthorized activation")
	}
	if send(catalog.Addr().String(), "/enroll", "synthetic-caller-a", body) != 404 {
		t.Fatal("enrollment exposed on catalog listener")
	}
	if send(enrollment.Addr().String(), "/enroll", "synthetic-service", body) != 201 {
		t.Fatal("enrollment failed")
	}
	if send(enrollment.Addr().String(), "/enroll", "synthetic-service", append(body, []byte(" {}")...)) != 400 {
		t.Fatal("accepted trailing JSON")
	}
	unknown := append(append([]byte(nil), body[:len(body)-1]...), []byte(`,"impersonate":"example-b"}`)...)
	if send(enrollment.Addr().String(), "/enroll", "synthetic-service", unknown) != 400 {
		t.Fatal("accepted unknown identity field")
	}
	if send(enrollment.Addr().String(), "/enroll", "synthetic-service", bytes.Repeat([]byte(" "), 33<<10)) != 400 {
		t.Fatal("accepted oversized enrollment")
	}
	r, _ := http.NewRequest(http.MethodGet, "http://"+catalog.Addr().String()+"/catalog", nil)
	r.Header.Set("Authorization", "Bearer synthetic-caller-a")
	response, err := client.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	var catalogEntries []CatalogEntry
	decodeErr := json.NewDecoder(response.Body).Decode(&catalogEntries)
	response.Body.Close()
	if response.StatusCode != 200 || decodeErr != nil || len(catalogEntries) != 1 || catalogEntries[0].ID != "a" {
		t.Fatal("authenticated catalog listener failed")
	}
	a.Endpoint = "http://localhost/denied"
	bad, _ := json.Marshal(a)
	if send(enrollment.Addr().String(), "/enroll", "synthetic-service", bad) != 400 {
		t.Fatal("enrolled unauthorized destination")
	}
	if send(catalog.Addr().String(), "/catalog", "synthetic-service", nil) != 401 {
		t.Fatal("service token impersonated caller")
	}
	if err := app.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	for _, address := range []string{catalog.Addr().String(), enrollment.Addr().String()} {
		c, err := net.DialTimeout("tcp", address, 50*time.Millisecond)
		if err == nil {
			c.Close()
			t.Fatal("listener leaked")
		}
	}
	if _, _, err := b.Execute(request("synthetic-caller-a"), "model", 1, dispatchFunc(okDispatch)); !errors.Is(err, ErrClosed) {
		t.Fatal("admitted after close")
	}
}

// A real subprocess exits in the notification callback, after receiver receipt
// but before durable ack. The next process must replay the same stable ID.
func TestCrashAfterNotificationBeforeAck(t *testing.T) {
	if dir := os.Getenv("BROKERAPP_CRASH_DIR"); dir != "" {
		s, err := OpenStore(dir)
		if err != nil {
			os.Exit(91)
		}
		if s.Activate(account("a", "http://localhost/a", "example-a")) != nil {
			os.Exit(92)
		}
		b, err := New(s, Config{CallerTokens: map[string]string{"synthetic-caller-a": "example-a"}, AllowedEndpoints: []string{"http://localhost/a"}, Notify: func(_ context.Context, n Notification) error {
			data, _ := json.Marshal(n)
			if atomicFile(filepath.Join(dir, "receiver.json"), data) != nil {
				os.Exit(93)
			}
			os.Exit(23)
			return nil
		}})
		if err != nil {
			os.Exit(94)
		}
		_ = b.FlushNotifications(context.Background())
		os.Exit(95)
	}
	dir := t.TempDir()
	cmd := exec.Command(os.Args[0], "-test.run=^TestCrashAfterNotificationBeforeAck$")
	cmd.Env = append(os.Environ(), "BROKERAPP_CRASH_DIR="+dir)
	err := cmd.Run()
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 23 {
		t.Fatalf("crash helper: %v", err)
	}
	// An interrupted staging file must never become committed state.
	if err := os.WriteFile(filepath.Join(dir, ".broker-interrupted"), []byte("partial JSON"), 0600); err != nil {
		t.Fatal(err)
	}
	s, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	var received Notification
	data, err := os.ReadFile(filepath.Join(dir, "receiver.json"))
	if err != nil || json.Unmarshal(data, &received) != nil {
		t.Fatal("missing receiver receipt")
	}
	state := s.snapshot()
	if len(state.Accounts) != 1 || len(state.Outbox) != 1 || state.Outbox[0] != received {
		t.Fatal("crash lost atomic activation or stable ID")
	}
	// Receiver dedup: two transport deliveries, one effective notification.
	effective := map[uint64]bool{received.ID: true}
	deliveries := 1
	b := broker(t, s, Config{Notify: func(_ context.Context, n Notification) error { deliveries++; effective[n.ID] = true; return nil }})
	if err := b.FlushNotifications(context.Background()); err != nil {
		t.Fatal(err)
	}
	if deliveries != 2 || len(effective) != 1 || len(s.snapshot().Outbox) != 0 {
		t.Fatal("restart notification/dedup failed")
	}
	reopened, err := OpenStore(dir)
	if err != nil || len(reopened.snapshot().Outbox) != 0 {
		t.Fatal("ack not durable")
	}
}

func TestNotificationRetryAndCleanupCancellation(t *testing.T) {
	s := openStore(t)
	activate(t, s, account("a", "http://localhost/a", "example-a"))
	var calls atomic.Int32
	done := make(chan struct{})
	b := broker(t, s, Config{Notify: func(context.Context, Notification) error {
		if calls.Add(1) == 1 {
			return errors.New("synthetic receiver failure")
		}
		select {
		case <-done:
		default:
			close(done)
		}
		return nil
	}})
	app, err := Start(b, listener(t), listener(t), "synthetic-service", time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close(context.Background())
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("outbox worker did not retry")
	}
	if err := app.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(s.snapshot().Outbox) != 0 {
		t.Fatal("worker ack missing")
	}
}

func TestCloseCancelsRefreshAndActiveDispatch(t *testing.T) {
	for _, refresh := range []bool{false, true} {
		t.Run(fmt.Sprint(refresh), func(t *testing.T) {
			s := openStore(t)
			a := account("a", "http://localhost/a", "example-a")
			if refresh {
				a.Credential.Expires = time.Time{}
			}
			activate(t, s, a)
			started := make(chan struct{})
			finished := make(chan error, 1)
			block := func(ctx context.Context) { close(started); <-ctx.Done() }
			b := broker(t, s, Config{Refresh: func(ctx context.Context, _ string, _ Credential) (Credential, error) {
				block(ctx)
				return Credential{}, ctx.Err()
			}})
			go func() {
				_, _, err := b.Execute(request("synthetic-caller-a"), "model", 1, dispatchFunc(func(ctx context.Context, _ Attempt) (AttemptResult, error) {
					block(ctx)
					return AttemptResult{}, ctx.Err()
				}))
				finished <- err
			}()
			<-started
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			if err := b.Close(ctx); err != nil {
				t.Fatal(err)
			}
			if err := <-finished; err == nil {
				t.Fatal("canceled operation succeeded")
			}
		})
	}
}
