package brokerapp

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/NotRllyRn/proxykit/extension"
)

func TestHostFallbackRefreshRevocationRace(t *testing.T) {
	s := openStore(t)
	entered, release := make(chan struct{}), make(chan struct{})
	var fallbackHits atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/a" {
			w.WriteHeader(503)
			_, _ = io.WriteString(w, "original")
			return
		}
		fallbackHits.Add(1)
	}))
	defer upstream.Close()
	a := account("a", upstream.URL+"/a", "example-a")
	c := account("b", upstream.URL+"/b", "example-a")
	c.Credential.Expires = time.Now().Add(-time.Hour)
	activate(t, s, a)
	activate(t, s, c)
	b := broker(t, s, Config{AllowedEndpoints: []string{a.Endpoint, c.Endpoint}, Refresh: func(ctx context.Context, _ string, _ Credential) (Credential, error) {
		close(entered)
		select {
		case <-release:
		case <-ctx.Done():
			return Credential{}, ctx.Err()
		}
		return Credential{Token: "must-not-publish", Expires: time.Now().Add(time.Hour)}, nil
	}})
	_, server := hostFixture(t, b, HostConfig{})
	done := make(chan int, 1)
	go func() { status, _ := hostRequest(t, server.URL, "GET", "synthetic-caller-a", ""); done <- status }()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("refresh never entered")
	}
	c.Active = false
	activate(t, s, c)
	close(release)
	select {
	case status := <-done:
		if status != 503 {
			t.Fatal(status)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("refresh stuck")
	}
	if fallbackHits.Load() != 0 || s.snapshot().Accounts[c.ID].Active || s.snapshot().Accounts[c.ID].Credential.Token == "must-not-publish" {
		t.Fatal("refresh revived revoked fallback")
	}
}

func TestHostCancellationAndShutdown(t *testing.T) {
	for _, shutdown := range []bool{false, true} {
		name := "caller"
		if shutdown {
			name = "shutdown"
		}
		t.Run(name, func(t *testing.T) {
			entered, canceled := make(chan struct{}), make(chan struct{})
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { close(entered); <-r.Context().Done(); close(canceled) }))
			defer upstream.Close()
			s := openStore(t)
			a := account("a", upstream.URL, "example-a")
			activate(t, s, a)
			b := broker(t, s, Config{AllowedEndpoints: []string{a.Endpoint}})
			h, server := hostFixture(t, b, HostConfig{Execution: extension.Config{OperationTimeout: 5 * time.Second}})
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			r, _ := http.NewRequestWithContext(ctx, "GET", server.URL, nil)
			r.Header.Set("Authorization", "Bearer synthetic-caller-a")
			done := make(chan struct{})
			go func() {
				resp, _ := http.DefaultClient.Do(r)
				if resp != nil {
					resp.Body.Close()
				}
				close(done)
			}()
			select {
			case <-entered:
			case <-time.After(3 * time.Second):
				t.Fatal("not dispatched")
			}
			if shutdown {
				closectx, end := context.WithTimeout(context.Background(), 3*time.Second)
				defer end()
				if err := h.Close(closectx); err != nil {
					t.Fatal(err)
				}
			} else {
				cancel()
			}
			select {
			case <-canceled:
			case <-time.After(3 * time.Second):
				t.Fatal("upstream not canceled")
			}
			select {
			case <-done:
			case <-time.After(3 * time.Second):
				t.Fatal("caller stuck")
			}
		})
	}
}
