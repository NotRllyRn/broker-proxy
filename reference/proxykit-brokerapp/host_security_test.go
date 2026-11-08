package brokerapp

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/NotRllyRn/proxykit/extension"
)

func TestHostRefreshSingleflightAndSanitizedFailure(t *testing.T) {
	for _, fail := range []bool{false, true} {
		name := "singleflight"
		if fail {
			name = "sanitized-failure"
		}
		t.Run(name, func(t *testing.T) {
			var refresh, hits atomic.Int32
			entered, release := make(chan struct{}), make(chan struct{})
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				hits.Add(1)
				if r.Header.Get("Authorization") != "Bearer refreshed" {
					t.Error("incorrect refreshed auth")
				}
				_, _ = io.WriteString(w, "ok")
			}))
			defer upstream.Close()
			s := openStore(t)
			a := account("a", upstream.URL, "example-a")
			a.Credential.Expires = time.Now().Add(-time.Hour)
			activate(t, s, a)
			b := broker(t, s, Config{AllowedEndpoints: []string{a.Endpoint}, Refresh: func(ctx context.Context, _ string, _ Credential) (Credential, error) {
				if refresh.Add(1) == 1 {
					close(entered)
				}
				select {
				case <-release:
				case <-ctx.Done():
					return Credential{}, ctx.Err()
				}
				if fail {
					return Credential{}, errors.New("synthetic-private-callback-detail")
				}
				return Credential{Token: "refreshed", Expires: time.Now().Add(time.Hour)}, nil
			}})
			var mu sync.Mutex
			var observations []string
			finished := make(chan struct{}, 24)
			stage := extension.Observe
			if fail {
				stage = extension.Finish
			}
			regs := []extension.Registration{{Owner: "recorder", ID: "recorder.terminal", Stage: stage, Handler: func(_ context.Context, in extension.Input) (extension.Result, error) {
				mu.Lock()
				observations = append(observations, fmt.Sprint(in.Err, in.Ledger, in.Request.Header, in.Requested.Header, in.Metadata))
				mu.Unlock()
				finished <- struct{}{}
				return extension.Result{}, nil
			}}}
			_, server := hostFixture(t, b, HostConfig{Registrations: regs})
			n := 24
			if fail {
				n = 1
			}
			var wg sync.WaitGroup
			for i := 0; i < n; i++ {
				wg.Add(1)
				go func() {
					defer wg.Done()
					status, _ := hostRequest(t, server.URL, "GET", "synthetic-caller-a", "")
					want := 200
					if fail {
						want = 502
					}
					if status != want {
						t.Errorf("status %d want %d", status, want)
					}
				}()
			}
			select {
			case <-entered:
			case <-time.After(3 * time.Second):
				t.Fatal("refresh not entered")
			}
			close(release)
			wg.Wait()
			// Observe is pre-delivery for successful attempts. Pre-dispatch failure
			// has Finish instead; successful Finish is not a delivery guarantee.
			for i := 0; i < n; i++ {
				select {
				case <-finished:
				case <-time.After(3 * time.Second):
					t.Fatal("terminal observer did not complete")
				}
			}
			if refresh.Load() != 1 {
				t.Fatal("refresh not singleflight", refresh.Load())
			}
			mu.Lock()
			defer mu.Unlock()
			if len(observations) != n {
				t.Fatal("missing terminal observations", len(observations))
			}
			for _, v := range observations {
				for _, secret := range []string{"synthetic-private-callback-detail", "synthetic-caller-a", "synthetic-a", "Bearer refreshed"} {
					if strings.Contains(v, secret) {
						t.Fatal("credential/raw callback error in recorder", secret)
					}
				}
			}
			if fail && hits.Load() != 0 {
				t.Fatal("failed refresh dispatched")
			}
		})
	}
}

func TestHostRejectsLateCredentialTrailers(t *testing.T) {
	var hits atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hits.Add(1) }))
	defer upstream.Close()
	s := openStore(t)
	a := account("a", upstream.URL, "example-a")
	activate(t, s, a)
	b := broker(t, s, Config{AllowedEndpoints: []string{a.Endpoint}})
	_, server := hostFixture(t, b, HostConfig{})
	r, _ := http.NewRequest("POST", server.URL, strings.NewReader("data"))
	r.ContentLength = -1
	r.Header.Set("Authorization", "Bearer synthetic-caller-a")
	r.Trailer = http.Header{"Authorization": {"Bearer late-caller-secret"}}
	resp, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode != 400 || hits.Load() != 0 {
		t.Fatal("forwarded late credential trailer", resp.StatusCode, hits.Load())
	}
}
