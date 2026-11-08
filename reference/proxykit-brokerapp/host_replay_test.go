package brokerapp

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/NotRllyRn/proxykit/extension"
)

func TestHostReplayStartsBeforeTransformsAndRejectsEffectivePost(t *testing.T) {
	for _, post := range []bool{false, true} {
		name := "saved-input"
		if post {
			name = "effective-post"
		}
		t.Run(name, func(t *testing.T) {
			var hits atomic.Int32
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				hits.Add(1)
				body, _ := io.ReadAll(r.Body)
				if string(body) != "data!" || r.Header.Get("Content-Type") != "application/example" {
					t.Errorf("transform replayed or header lost: %s %s", body, r.Header.Get("Content-Type"))
				}
				if r.URL.Path == "/a" {
					w.WriteHeader(503)
					return
				}
				_, _ = w.Write(body)
			}))
			defer upstream.Close()
			s := openStore(t)
			a := account("a", upstream.URL+"/a", "example-a")
			c := account("b", upstream.URL+"/b", "example-a")
			activate(t, s, a)
			activate(t, s, c)
			b := broker(t, s, Config{AllowedEndpoints: []string{a.Endpoint, c.Endpoint}})
			regs := []extension.Registration{{Owner: "transform", ID: "transform.request", Stage: extension.Prepare, Body: extension.Whole, Handler: func(_ context.Context, in extension.Input) (extension.Result, error) {
				m := in.Request
				m.Body = append(m.Body, '!')
				if post {
					m.Method = "POST"
				}
				return extension.Result{Action: extension.Replace, Message: &m}, nil
			}}}
			_, server := hostFixture(t, b, HostConfig{Registrations: regs})
			r, _ := http.NewRequest("GET", server.URL, strings.NewReader("data"))
			r.Header.Set("Content-Type", "application/example")
			r.Header.Set("Authorization", "Bearer synthetic-caller-a")
			resp, err := http.DefaultClient.Do(r)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			body, _ := io.ReadAll(resp.Body)
			if post {
				if resp.StatusCode != 503 || hits.Load() != 1 {
					t.Fatal("effective side effect replayed", resp.StatusCode, hits.Load())
				}
			} else {
				if resp.StatusCode != 200 || string(body) != "data!" || hits.Load() != 2 {
					t.Fatalf("replay %d %s %d", resp.StatusCode, body, hits.Load())
				}
			}
		})
	}
}

func TestHostDoesNotFollowProviderRedirect(t *testing.T) {
	var destinationHits atomic.Int32
	destination := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { destinationHits.Add(1) }))
	defer destination.Close()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, destination.URL, http.StatusTemporaryRedirect)
	}))
	defer upstream.Close()
	s := openStore(t)
	a := account("a", upstream.URL, "example-a")
	activate(t, s, a)
	b := broker(t, s, Config{AllowedEndpoints: []string{a.Endpoint}})
	_, server := hostFixture(t, b, HostConfig{})
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	r, _ := http.NewRequest("GET", server.URL, nil)
	r.Header.Set("Authorization", "Bearer synthetic-caller-a")
	resp, err := client.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 307 || destinationHits.Load() != 0 {
		t.Fatal("managed transport followed provider redirect")
	}
}
