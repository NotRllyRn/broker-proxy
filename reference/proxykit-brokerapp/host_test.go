package brokerapp

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/NotRllyRn/proxykit/extension"
)

func hostFixture(t *testing.T, b *Broker, cfg HostConfig) (*Host, *httptest.Server) {
	t.Helper()
	var err error
	cfg.Catalog, err = net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	cfg.Enrollment, err = net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	cfg.ServiceToken = "synthetic-service"
	cfg.RetryInterval = time.Hour
	h, err := NewHost(b, cfg)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(h)
	t.Cleanup(func() {
		server.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := h.Close(ctx); err != nil {
			t.Error(err)
		}
		for _, l := range []net.Listener{cfg.Catalog, cfg.Enrollment} {
			c, err := net.DialTimeout("tcp", l.Addr().String(), time.Second)
			if err == nil {
				c.Close()
				t.Error("application listener survived host shutdown")
			}
		}
	})
	return h, server
}
func hostRequest(t *testing.T, server, method, token, body string) (int, string) {
	t.Helper()
	r, err := http.NewRequest(method, server+"/public?account=b", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	r.Header.Set("X-Caller-ID", "example-b")
	r.Header.Set("X-Account-ID", "b")
	resp, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	out, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return resp.StatusCode, string(out)
}

func TestHostConcurrentCompositionOriginalAndDelivery(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := strings.TrimPrefix(r.URL.Path, "/")
		if r.Header.Get("Authorization") != "Bearer synthetic-"+id || r.Header.Get("X-Account-ID") != "" {
			t.Error("credential/identity leak")
		}
		if id == "a" {
			w.Header().Set("X-Example-Usage", "7")
		}
		_, _ = io.WriteString(w, "original-"+id)
	}))
	defer upstream.Close()
	s := openStore(t)
	a := account("a", upstream.URL+"/a", "example-a")
	bAccount := account("b", upstream.URL+"/b", "example-b")
	activate(t, s, a)
	activate(t, s, bAccount)
	b := broker(t, s, Config{AllowedEndpoints: []string{a.Endpoint, bAccount.Endpoint}})
	var mu sync.Mutex
	originals := map[string]string{}
	unknown, known, deliveries := 0, 0, 0
	delivered := make(chan struct{}, 40)
	regs := []extension.Registration{
		{Owner: "recorder", ID: "independent.headers", Stage: extension.Observe, Handler: func(_ context.Context, in extension.Input) (extension.Result, error) {
			if in.Request.Header.Get("Authorization") != "" || in.Requested.Header.Get("Authorization") != "" {
				t.Error("observer saw credential")
			}
			mu.Lock()
			defer mu.Unlock()
			if in.Response.Header.Get("X-Example-Usage") == "" {
				unknown++
			} else {
				known++
			}
			return extension.Result{}, nil
		}},
		{Owner: "recorder", ID: "independent.original", Stage: extension.OriginalBody, Body: extension.Unit, Handler: func(_ context.Context, in extension.Input) (extension.Result, error) {
			mu.Lock()
			originals[in.Identity.Root] += string(in.Response.Body)
			mu.Unlock()
			return extension.Result{}, nil
		}},
		{Owner: "presentation", ID: "presentation.decorate", Stage: extension.ResponseBody, Body: extension.Whole, Handler: func(_ context.Context, in extension.Input) (extension.Result, error) {
			m := in.Response
			m.Body = []byte("shown")
			return extension.Result{Action: extension.Replace, Message: &m}, nil
		}},
		{Owner: "recorder", ID: "independent.delivery", Stage: extension.Delivery, Handler: func(_ context.Context, in extension.Input) (extension.Result, error) {
			if in.Delivery == nil || in.Delivery.Status != 200 || in.Delivery.Bytes != 5 || !in.Delivery.Returned {
				t.Errorf("wrong final delivery: %+v", in.Delivery)
			}
			mu.Lock()
			deliveries++
			mu.Unlock()
			delivered <- struct{}{}
			return extension.Result{}, nil
		}},
	}
	_, server := hostFixture(t, b, HostConfig{Registrations: regs})
	var wg sync.WaitGroup
	for i := 0; i < 40; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			token := "synthetic-caller-a"
			if i%2 != 0 {
				token = "synthetic-caller-b"
			}
			status, body := hostRequest(t, server.URL, "GET", token, "")
			if status != 200 || body != "shown" {
				t.Errorf("%d %s", status, body)
			}
		}(i)
	}
	wg.Wait()
	for i := 0; i < 40; i++ {
		select {
		case <-delivered:
		case <-time.After(3 * time.Second):
			t.Fatal("delivery observer did not complete")
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if known != 20 || unknown != 20 || deliveries != 40 || len(originals) != 40 {
		t.Fatalf("known=%d unknown=%d delivery=%d original=%d", known, unknown, deliveries, len(originals))
	}
	for _, v := range originals {
		if v != "original-a" && v != "original-b" {
			t.Fatal("decorated original", v)
		}
	}
}

func TestHostFallbackFreshPolicyAndReplayBounds(t *testing.T) {
	for _, mode := range []string{"fallback", "revoked", "destination", "post", "overflow", "budget", "refresh"} {
		t.Run(mode, func(t *testing.T) {
			s := openStore(t)
			var a, c Account
			var hitsA, hitsB, refresh atomic.Int32
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/a" {
					hitsA.Add(1)
					switch mode {
					case "revoked":
						c.Active = false
						activate(t, s, c)
					case "destination":
						c.Endpoint = "http://disallowed.invalid"
						activate(t, s, c)
					}
					w.Header().Set("X-Example-Usage", "7")
					w.WriteHeader(503)
					_, _ = io.WriteString(w, "original failure")
					return
				}
				hitsB.Add(1)
				want := "Bearer synthetic-b"
				if mode == "refresh" {
					want = "Bearer refreshed"
				}
				if r.Header.Get("Authorization") != want {
					t.Error("stale/wrong fallback credential")
				}
				data, _ := io.ReadAll(r.Body)
				_, _ = w.Write(append([]byte("success:"), data...))
			}))
			defer upstream.Close()
			a = account("a", upstream.URL+"/a", "example-a")
			c = account("b", upstream.URL+"/b", "example-a")
			if mode == "refresh" {
				c.Credential.Expires = time.Now().Add(-time.Hour)
			}
			activate(t, s, a)
			activate(t, s, c)
			b := broker(t, s, Config{AllowedEndpoints: []string{a.Endpoint, c.Endpoint}, Refresh: func(context.Context, string, Credential) (Credential, error) {
				refresh.Add(1)
				return Credential{Token: "refreshed", Expires: time.Now().Add(time.Hour)}, nil
			}})
			var usageMu sync.Mutex
			var observedUsage []*Usage
			cfg := HostConfig{Registrations: []extension.Registration{{Owner: "recorder", ID: "recorder.fallback-usage", Stage: extension.Observe, Handler: func(_ context.Context, in extension.Input) (extension.Result, error) {
				var usage *Usage // missing second-account usage stays unknown
				if in.Response.Header.Get("X-Example-Usage") == "7" {
					usage = &Usage{InputTokens: 7}
				}
				usageMu.Lock()
				observedUsage = append(observedUsage, usage)
				usageMu.Unlock()
				return extension.Result{}, nil
			}}}}
			if mode == "overflow" {
				cfg.Execution.BodyBytes = 3
			}
			if mode == "budget" {
				cfg.Execution.Attempts = 1
			}
			_, server := hostFixture(t, b, cfg)
			method := "GET"
			if mode == "post" {
				method = "POST"
			}
			status, body := hostRequest(t, server.URL, method, "synthetic-caller-a", "data")
			switch mode {
			case "fallback", "refresh":
				if status != 200 || body != "success:data" || hitsB.Load() != 1 {
					t.Fatalf("%d %s hits=%d", status, body, hitsB.Load())
				}
			case "overflow":
				if status != 502 || hitsA.Load() != 0 || hitsB.Load() != 0 {
					t.Fatalf("overflow dispatched %d %d/%d", status, hitsA.Load(), hitsB.Load())
				}
			default:
				if status != 503 || body != "original failure" || hitsB.Load() != 0 {
					t.Fatalf("unsafe fallback %d %s %d", status, body, hitsB.Load())
				}
			}
			if mode == "refresh" && refresh.Load() != 1 {
				t.Fatal("missing refresh")
			}
			usageMu.Lock()
			defer usageMu.Unlock()
			if mode != "overflow" && (len(observedUsage) == 0 || observedUsage[0] == nil || observedUsage[0].InputTokens != 7) {
				t.Fatal("lost failed-attempt original usage")
			}
			if hitsB.Load() == 1 && (len(observedUsage) != 2 || observedUsage[1] != nil) {
				t.Fatal("missing fallback usage fabricated as zero")
			}
		})
	}
}

func TestHostScopedHTTPAuthAndOneSlot(t *testing.T) {
	for _, slots := range []int{1, 8} {
		t.Run(string(rune('0'+slots)), func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer synthetic-a" {
					t.Error("nested auth")
				}
				_, _ = io.WriteString(w, "ok")
			}))
			defer upstream.Close()
			s := openStore(t)
			a := account("a", upstream.URL, "example-a")
			activate(t, s, a)
			b := broker(t, s, Config{AllowedEndpoints: []string{a.Endpoint}})
			var h *Host
			var server *httptest.Server
			var saved *http.Client
			regs := []extension.Registration{{Owner: "nested", ID: "nested.http", Stage: extension.Prepare, Handler: func(ctx context.Context, in extension.Input) (extension.Result, error) {
				if in.Identity.Depth != 0 {
					return extension.Result{}, nil
				}
				client, err := h.Engine.Client(ctx, server.URL)
				if err != nil {
					return extension.Result{}, err
				}
				saved = client
				resp, err := client.Get(server.URL + "/nested")
				if err != nil {
					return extension.Result{}, err
				}
				defer resp.Body.Close()
				body, _ := io.ReadAll(resp.Body)
				want := 200
				if slots == 1 {
					want = 502
				}
				if resp.StatusCode != want {
					t.Errorf("nested status %d body %s", resp.StatusCode, body)
				}
				if _, err := client.Get(upstream.URL); err == nil {
					t.Error("capability escaped origin")
				}
				return extension.Result{}, nil
			}}}
			h, server = hostFixture(t, b, HostConfig{Execution: extension.Config{Admission: slots}, Registrations: regs})
			if status, _ := hostRequest(t, server.URL, "GET", "synthetic-caller-a", ""); status != 200 {
				t.Fatal(status)
			}
			if _, err := saved.Get(server.URL); err == nil {
				t.Error("expired capability accepted")
			}
			for _, token := range []string{"", "example-a", "synthetic-service"} {
				if status, _ := hostRequest(t, server.URL, "GET", token, ""); status != 401 {
					t.Fatal("public spoof accepted", status)
				}
			}
			r, _ := http.NewRequest("GET", server.URL, nil)
			r.Header.Set("X-Proxykit-Capability", "forged")
			r.Header.Set("Authorization", "Bearer synthetic-caller-a")
			resp, err := http.DefaultClient.Do(r)
			if err != nil {
				t.Fatal(err)
			}
			resp.Body.Close()
			if resp.StatusCode != 401 {
				t.Fatal("forged capability accepted")
			}
		})
	}
}

func TestHostFailedAndNoopTransformsPreserveBytes(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(map[bool]string{false: "noop", true: "failed"}[fail], func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.Copy(w, r.Body) }))
			defer upstream.Close()
			s := openStore(t)
			a := account("a", upstream.URL, "example-a")
			activate(t, s, a)
			b := broker(t, s, Config{AllowedEndpoints: []string{a.Endpoint}})
			regs := []extension.Registration{
				{Owner: "transform", ID: "transform.request-noop", Stage: extension.Prepare, Body: extension.Whole, Failure: extension.FailOpen, Handler: func(_ context.Context, in extension.Input) (extension.Result, error) {
					in.Request.Body[0] = 'X'
					if fail {
						return extension.Result{}, errors.New("synthetic failure")
					}
					return extension.Result{}, nil
				}},
				{Owner: "transform", ID: "transform.body", Stage: extension.ResponseBody, Body: extension.Whole, Failure: extension.FailOpen, Handler: func(_ context.Context, in extension.Input) (extension.Result, error) {
					in.Response.Body[0] = 'X'
					if fail {
						return extension.Result{}, errors.New("synthetic failure")
					}
					return extension.Result{}, nil
				}}}
			_, server := hostFixture(t, b, HostConfig{Registrations: regs})
			if status, body := hostRequest(t, server.URL, "POST", "synthetic-caller-a", "unchanged"); status != 200 || body != "unchanged" {
				t.Fatalf("%d %s", status, body)
			}
		})
	}
}
