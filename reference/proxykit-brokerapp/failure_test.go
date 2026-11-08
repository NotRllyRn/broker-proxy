package brokerapp

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestConcurrentIdentitiesKeepRoutesLocal(t *testing.T) {
	s := openStore(t)
	activate(t, s, account("a", "http://localhost/a", "example-a"))
	activate(t, s, account("b", "http://localhost/b", "example-b"))
	b := broker(t, s, Config{})
	var wg sync.WaitGroup
	for i := 0; i < 80; i++ {
		id := "a"
		if i%2 == 1 {
			id = "b"
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, out, err := b.Execute(request("synthetic-caller-"+id), "requested-"+id, 2, dispatchFunc(func(_ context.Context, a Attempt) (AttemptResult, error) {
				if a.AccountID != id || a.Endpoint != "http://localhost/"+id || a.Credential.Token != "synthetic-"+id {
					t.Error("cross-caller route/credential contamination")
				}
				return AttemptResult{Status: 200}, nil
			}))
			if err != nil || len(out) != 1 || out[0].Caller != "example-"+id || out[0].RequestedModel != "requested-"+id {
				t.Error("cross-caller provenance contamination")
			}
		}()
	}
	wg.Wait()
}

func TestCallbackErrorsAreNotObservations(t *testing.T) {
	s := openStore(t)
	activate(t, s, account("a", "http://localhost/a", "example-a"))
	b := broker(t, s, Config{})
	_, out, err := b.Execute(request("synthetic-caller-a"), "model", 1, dispatchFunc(func(context.Context, Attempt) (AttemptResult, error) {
		return AttemptResult{}, errors.New("synthetic-a must stay private")
	}))
	data, _ := json.Marshal(out)
	if !errors.Is(err, ErrDispatch) || strings.Contains(err.Error(), "synthetic-a") || strings.Contains(string(data), "synthetic-a") || strings.Contains(string(data), "Credential") {
		t.Fatal("dispatcher error leaked credential")
	}
	a := account("a", "http://localhost/a", "example-a")
	a.Credential.Expires = time.Time{}
	activate(t, s, a)
	b.refresh = func(context.Context, string, Credential) (Credential, error) {
		return Credential{}, errors.New("synthetic-a must stay private")
	}
	_, _, err = b.Execute(request("synthetic-caller-a"), "model", 1, dispatchFunc(okDispatch))
	if !errors.Is(err, ErrRefresh) || strings.Contains(err.Error(), "synthetic-a") {
		t.Fatal("refresh error leaked credential")
	}
}

func TestEnrollmentCommitFailureNeverPublishes(t *testing.T) {
	s := openStore(t)
	s.persist = func(string, []byte) error { return errors.New("synthetic storage fault") }
	b := broker(t, s, Config{})
	catalog, enrollment := listener(t), listener(t)
	app, err := Start(b, catalog, enrollment, "synthetic-service", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close(context.Background())
	a := account("a", "http://localhost/a", "example-a")
	data, _ := json.Marshal(a)
	r, _ := http.NewRequest(http.MethodPost, "http://"+enrollment.Addr().String()+"/enroll", strings.NewReader(string(data)))
	r.Header.Set("Authorization", "Bearer synthetic-service")
	client := &http.Client{Timeout: time.Second}
	resp, err := client.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 503 || strings.Contains(string(body), "synthetic-") {
		t.Fatal("failed transaction response was not sanitized")
	}
	_, out, err := b.Execute(request("synthetic-caller-a"), "model", 1, dispatchFunc(okDispatch))
	if !errors.Is(err, ErrStore) || len(out) != 0 {
		t.Fatal("HTTP activation published before commit")
	}
	if _, err := os.Stat(s.path); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("failed initial activation wrote durable state")
	}
}

func TestCloseCancelsNotificationAndRetryHasNoLostOutbox(t *testing.T) {
	s := openStore(t)
	activate(t, s, account("a", "http://localhost/a", "example-a"))
	started := make(chan struct{})
	b := broker(t, s, Config{Notify: func(ctx context.Context, _ Notification) error { close(started); <-ctx.Done(); return ctx.Err() }})
	app, err := Start(b, listener(t), listener(t), "synthetic-service", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	<-started
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	// Broker.Close itself must release Application listeners and the job.
	if err := b.Close(ctx); err != nil {
		t.Fatal(err)
	}
	if err := app.Close(ctx); err != nil {
		t.Fatal(err)
	}
	if len(s.snapshot().Outbox) != 1 {
		t.Fatal("canceled notification was acknowledged")
	}
}

func TestSingleApplicationAndServiceCredentialSeparation(t *testing.T) {
	b := broker(t, openStore(t), Config{})
	if _, err := Start(b, listener(t), listener(t), "synthetic-caller-a", time.Second); !errors.Is(err, ErrInvalid) {
		t.Fatal("allowed service/caller credential reuse")
	}
	app, err := Start(b, listener(t), listener(t), "synthetic-service", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close(context.Background())
	if _, err := Start(b, listener(t), listener(t), "another-synthetic-service", time.Hour); !errors.Is(err, ErrInvalid) {
		t.Fatal("started multiple application lifecycles")
	}
}
