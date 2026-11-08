// Installs only the unrelated synthetic header fixture through the real pinned
// Installer. Broker installation still uses the unmodified CLI and real GitHub.
package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"

	"github.com/NotRllyRn/proxykit/extensions"
)

func main() {
	const revision = "2222222222222222222222222222222222222222" // Synthetic fixture identity, not a GitHub commit.
	var archive bytes.Buffer
	gz := gzip.NewWriter(&archive)
	z := tar.NewWriter(gz)
	for name, content := range map[string]string{
		"proxykit-extension.json": `{"manifestVersion":1,"apiVersion":1,"id":"activation-fixture","version":"1.0.0","entry":"extension.mjs"}`,
		"extension.mjs":           `export default api => api.on({id:'header',stage:'responseStart',bodyMode:'none'}, input => ({action:'replace',message:{...input.response,header:{...input.response.header,'X-Activation-Fixture':['enabled']}}}));`,
	} {
		if err := z.WriteHeader(&tar.Header{Name: "fixture/" + name, Mode: 0600, Size: int64(len(content))}); err != nil {
			panic(err)
		}
		if _, err := z.Write([]byte(content)); err != nil {
			panic(err)
		}
	}
	if err := z.Close(); err != nil {
		panic(err)
	}
	if err := gz.Close(); err != nil {
		panic(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/commits/") {
			json.NewEncoder(w).Encode(map[string]string{"sha": revision})
			return
		}
		w.Write(archive.Bytes())
	}))
	defer srv.Close()
	installer := extensions.Installer{Store: os.Getenv("PROXYKIT_EXTENSIONS_DIR"), APIBase: srv.URL, ArchiveBase: srv.URL}
	if _, err := installer.Install(context.Background(), "https://github.com/example/activation-fixture/tree/"+revision, true); err != nil {
		panic(err)
	}
}
