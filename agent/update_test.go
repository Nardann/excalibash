package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

// ---- helpers ---------------------------------------------------------------

type release struct {
	pub      ed25519.PublicKey
	priv     ed25519.PrivateKey
	version  string
	binary   []byte
	manifest []byte
	sig      string
}

// newRelease signs a manifest for the current platform carrying binary.
func newRelease(t *testing.T, version string, binary []byte) *release {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	r := &release{pub: pub, priv: priv, version: version, binary: binary}
	r.setManifest(t, version, map[string]manifestEntry{runtime.GOOS + "-" + runtime.GOARCH: entryOf(binary)})
	return r
}

func entryOf(b []byte) manifestEntry {
	sum := sha256.Sum256(b)
	return manifestEntry{SHA256: hex.EncodeToString(sum[:]), Size: int64(len(b))}
}

func (r *release) setManifest(t *testing.T, version string, files map[string]manifestEntry) {
	t.Helper()
	raw, err := json.MarshalIndent(releaseManifest{Version: version, Date: "2026-01-01T00:00:00Z", Files: files}, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	r.manifest = raw
	r.sig = base64.StdEncoding.EncodeToString(ed25519.Sign(r.priv, raw))
}

func (r *release) serve(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/downloads/agent-manifest.json", func(w http.ResponseWriter, _ *http.Request) { w.Write(r.manifest) })
	mux.HandleFunc("/downloads/agent-manifest.json.sig", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte(r.sig)) })
	mux.HandleFunc("/downloads/excalibash-agent-"+runtime.GOOS+"-"+runtime.GOARCH, func(w http.ResponseWriter, _ *http.Request) { w.Write(r.binary) })
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

// testUpdater is an updater whose executable lives in a temp dir and whose exec is recorded.
type testUpdater struct {
	*updater
	exe      string
	execs    [][]string
	execErr  error
	auth     []byte
	closed   bool
	execArgv []string
}

func newTestUpdater(t *testing.T, r *release, srv *httptest.Server, current string) *testUpdater {
	t.Helper()
	dir := t.TempDir()
	exe := filepath.Join(dir, "excalibash-agent")
	if err := os.WriteFile(exe, []byte("v1 binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	auth := make([]byte, 32)
	rand.Read(auth)
	u := newUpdater(auth)
	u.key, u.keyErr = r.pub, nil
	u.current, u.allowDev = current, false
	if srv != nil {
		if err := u.configure("ws"+strings.TrimPrefix(srv.URL, "http")+"/agent", false, ""); err != nil {
			t.Fatal(err)
		}
	}
	tu := &testUpdater{updater: u, exe: exe, auth: auth}
	u.exePath = func() (string, error) { return exe, nil }
	u.flush = func(*outbox) {}
	u.beforeExec = func() { tu.closed = true }
	u.environ = func() []string { return []string{"PATH=/bin", envRolledBack + "=1"} }
	u.execFn = func(argv0 string, argv, env []string) error {
		tu.execs = append(tu.execs, append([]string{argv0}, env...))
		return tu.execErr
	}
	return tu
}

func updateRequest(t *testing.T, auth []byte, rid string, ts int64, op string) message {
	t.Helper()
	pt, _ := json.Marshal(map[string]string{"op": op})
	boxed, err := box(auth, pt, "eb:update:"+rid+":"+strconv.FormatInt(ts, 10))
	if err != nil {
		t.Fatal(err)
	}
	return message{T: "update", Rid: rid, Ts: json.RawMessage(strconv.FormatInt(ts, 10)), D: b64.EncodeToString(boxed)}
}

// frames drains the update.res frames sent so far and opens them.
func frames(t *testing.T, auth []byte, rid string, out *outbox) []map[string]any {
	t.Helper()
	var all []map[string]any
	for {
		select {
		case b := <-out.ch:
			var m message
			json.Unmarshal(b, &m)
			if m.T != "update.res" || m.Rid != rid {
				t.Fatalf("unexpected frame %s", b)
			}
			data, _ := b64.DecodeString(m.D)
			pt, err := unbox(auth, data, "eb:update-res:"+rid)
			if err != nil {
				t.Fatalf("frame not boxed under the machine key: %v", err)
			}
			var f map[string]any
			json.Unmarshal(pt, &f)
			f["end"] = m.End
			all = append(all, f)
		default:
			return all
		}
	}
}

func lastFrame(fs []map[string]any) map[string]any {
	if len(fs) == 0 {
		return map[string]any{}
	}
	return fs[len(fs)-1]
}

func newOut() *outbox { return &outbox{ch: make(chan []byte, 32), done: make(chan struct{})} }

// ---- signature ------------------------------------------------------------------

func TestVerifyManifest(t *testing.T) {
	r := newRelease(t, "2.0.0", []byte("bin"))
	if m, err := verifyManifest(r.pub, r.manifest, []byte(r.sig+"\n")); err != nil || m.Version != "2.0.0" {
		t.Fatalf("good signature refused: %v", err)
	}
	other, _, _ := ed25519.GenerateKey(rand.Reader)
	if _, err := verifyManifest(other, r.manifest, []byte(r.sig)); err == nil {
		t.Error("signature of another key accepted")
	}
	tampered := []byte(strings.Replace(string(r.manifest), "2.0.0", "9.9.9", 1))
	if _, err := verifyManifest(r.pub, tampered, []byte(r.sig)); err == nil {
		t.Error("tampered manifest accepted")
	}
	for _, bad := range []string{"", "not base64!", base64.StdEncoding.EncodeToString([]byte("short"))} {
		if _, err := verifyManifest(r.pub, r.manifest, []byte(bad)); err == nil {
			t.Errorf("signature %q accepted", bad)
		}
	}
	if _, err := verifyManifest(nil, r.manifest, []byte(r.sig)); err == nil {
		t.Error("no key: accepted")
	}
}

func TestParseUpdateKey(t *testing.T) {
	if k, err := parseUpdateKey(""); k != nil || err != nil {
		t.Errorf("empty key: %v %v", k, err)
	}
	pub, _, _ := ed25519.GenerateKey(rand.Reader)
	if k, err := parseUpdateKey(" " + base64.StdEncoding.EncodeToString(pub) + "\n"); err != nil || !k.Equal(pub) {
		t.Errorf("valid key refused: %v", err)
	}
	for _, bad := range []string{"AAAA", "%%%", base64.StdEncoding.EncodeToString(make([]byte, 31))} {
		if _, err := parseUpdateKey(bad); err == nil {
			t.Errorf("key %q accepted", bad)
		}
	}
}

// ---- versions ----------------------------------------------------------------------

func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"1.0.0", "1.0.0", 0}, {"v1.0.0", "1.0.0", 0}, {"1.2.0", "1.1.9", 1}, {"1.10.0", "1.9.0", 1},
		{"2.0.0", "1.99.99", 1}, {"1.0", "1.0.0", 0}, {"1.0.0", "1.0.1", -1},
		{"1.0.0-rc.1", "1.0.0", -1}, {"1.0.0-rc.2", "1.0.0-rc.10", -1}, {"1.0.0+b5", "1.0.0", 0},
	}
	for _, c := range cases {
		got, err := compareVersions(c.a, c.b)
		if err != nil || got != c.want {
			t.Errorf("compare(%q,%q) = %d, %v; want %d", c.a, c.b, got, err, c.want)
		}
	}
	for _, bad := range []string{"", "dev", "abc", "1.x.0", "1.2.3.4"} {
		if _, err := compareVersions(bad, "1.0.0"); err == nil {
			t.Errorf("version %q accepted", bad)
		}
	}
}

func TestCheckUpgrade(t *testing.T) {
	if err := checkUpgrade("1.0.0", "1.0.1", false); err != nil {
		t.Errorf("upgrade refused: %v", err)
	}
	if err := checkUpgrade("1.0.1", "1.0.0", false); err == nil || !strings.Contains(err.Error(), "retour en arrière") {
		t.Errorf("downgrade: %v", err)
	}
	if err := checkUpgrade("1.0.0", "1.0.0", false); err == nil {
		t.Error("same version reinstalled")
	}
	if err := checkUpgrade("dev", "9.0.0", false); err == nil {
		t.Error("dev build updated without the test switch")
	}
	if err := checkUpgrade("dev", "9.0.0", true); err != nil {
		t.Errorf("dev with the test switch: %v", err)
	}
	if err := checkUpgrade("garbage", "2.0.0", false); err == nil {
		t.Error("unknown current version updated")
	}
}

// ---- procedure ----------------------------------------------------------------------

func installOnce(t *testing.T, tu *testUpdater) (*swapState, string, error) {
	t.Helper()
	return tu.install(context.Background(), &reporter{auth: tu.auth, rid: "r", out: newOut()})
}

func TestInstallSwapsExecutable(t *testing.T) {
	r := newRelease(t, "2.0.0", []byte("v2 binary"))
	tu := newTestUpdater(t, r, r.serve(t), "1.0.0")
	sw, v, err := installOnce(t, tu)
	if err != nil || v != "2.0.0" {
		t.Fatalf("install: %v %q", err, v)
	}
	if b, _ := os.ReadFile(tu.exe); string(b) != "v2 binary" {
		t.Errorf("executable not replaced: %q", b)
	}
	if b, _ := os.ReadFile(sw.old); string(b) != "v1 binary" || filepath.Base(sw.old) != updateOldName {
		t.Errorf("old binary not kept: %q", b)
	}
	if st, _ := os.Stat(tu.exe); st.Mode().Perm()&0o100 == 0 {
		t.Error("new executable not executable")
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(tu.exe), updateNewName)); !os.IsNotExist(err) {
		t.Error("temporary file left behind")
	}
	if err := sw.restore(); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(tu.exe); string(b) != "v1 binary" {
		t.Error("restore did not bring v1 back")
	}
}

func TestInstallRefusals(t *testing.T) {
	good := []byte("v2 binary")
	t.Run("no embedded key", func(t *testing.T) {
		r := newRelease(t, "2.0.0", good)
		tu := newTestUpdater(t, r, r.serve(t), "1.0.0")
		tu.key = nil
		if _, _, err := installOnce(t, tu); err == nil || !strings.Contains(err.Error(), "aucune clé de signature intégrée") {
			t.Errorf("err = %v", err)
		}
	})
	t.Run("signed by another key", func(t *testing.T) {
		r := newRelease(t, "2.0.0", good)
		tu := newTestUpdater(t, r, r.serve(t), "1.0.0")
		tu.key, _, _ = ed25519.GenerateKey(rand.Reader)
		if _, _, err := installOnce(t, tu); err == nil || !strings.Contains(err.Error(), "signature") {
			t.Errorf("err = %v", err)
		}
		assertUntouched(t, tu)
	})
	t.Run("tampered manifest", func(t *testing.T) {
		r := newRelease(t, "2.0.0", good)
		r.manifest = []byte(strings.Replace(string(r.manifest), `"size"`, `"size" `, 1))
		tu := newTestUpdater(t, r, r.serve(t), "1.0.0")
		if _, _, err := installOnce(t, tu); err == nil {
			t.Error("tampered manifest installed")
		}
		assertUntouched(t, tu)
	})
	t.Run("tampered binary", func(t *testing.T) {
		r := newRelease(t, "2.0.0", good)
		r.binary = []byte("v2 evil!!")
		tu := newTestUpdater(t, r, r.serve(t), "1.0.0")
		if _, _, err := installOnce(t, tu); err == nil || !strings.Contains(err.Error(), "empreinte") {
			t.Errorf("err = %v", err)
		}
		assertUntouched(t, tu)
	})
	t.Run("binary larger than signed size", func(t *testing.T) {
		r := newRelease(t, "2.0.0", good)
		r.binary = append(append([]byte{}, good...), make([]byte, 1000)...)
		tu := newTestUpdater(t, r, r.serve(t), "1.0.0")
		if _, _, err := installOnce(t, tu); err == nil {
			t.Error("oversized binary installed")
		}
		assertUntouched(t, tu)
	})
	t.Run("binary smaller than signed size", func(t *testing.T) {
		r := newRelease(t, "2.0.0", good)
		r.binary = good[:3]
		tu := newTestUpdater(t, r, r.serve(t), "1.0.0")
		if _, _, err := installOnce(t, tu); err == nil {
			t.Error("truncated binary installed")
		}
		assertUntouched(t, tu)
	})
	t.Run("signed size above the hard limit", func(t *testing.T) {
		r := newRelease(t, "2.0.0", good)
		e := entryOf(good)
		e.Size = maxUpdateBinary + 1
		r.setManifest(t, "2.0.0", map[string]manifestEntry{runtime.GOOS + "-" + runtime.GOARCH: e})
		tu := newTestUpdater(t, r, r.serve(t), "1.0.0")
		if _, _, err := installOnce(t, tu); err == nil {
			t.Error("size over 64 MiB accepted")
		}
		assertUntouched(t, tu)
	})
	t.Run("missing platform", func(t *testing.T) {
		r := newRelease(t, "2.0.0", good)
		r.setManifest(t, "2.0.0", map[string]manifestEntry{"plan9-mips": entryOf(good)})
		tu := newTestUpdater(t, r, r.serve(t), "1.0.0")
		if _, _, err := installOnce(t, tu); err == nil || !strings.Contains(err.Error(), "aucun binaire") {
			t.Errorf("err = %v", err)
		}
		assertUntouched(t, tu)
	})
	t.Run("downgrade and same version", func(t *testing.T) {
		r := newRelease(t, "2.0.0", good)
		for _, cur := range []string{"2.0.0", "3.0.0"} {
			tu := newTestUpdater(t, r, r.serve(t), cur)
			if _, _, err := installOnce(t, tu); err == nil {
				t.Errorf("current %s: updated to 2.0.0", cur)
			}
			assertUntouched(t, tu)
		}
	})
	t.Run("dev build", func(t *testing.T) {
		r := newRelease(t, "2.0.0", good)
		tu := newTestUpdater(t, r, r.serve(t), "dev")
		if _, _, err := installOnce(t, tu); err == nil {
			t.Error("dev build updated")
		}
		tu.allowDev = true
		if _, _, err := installOnce(t, tu); err != nil {
			t.Errorf("dev build with EXCALIBASH_ALLOW_DEV_UPDATE: %v", err)
		}
	})
	t.Run("server answers 404", func(t *testing.T) {
		r := newRelease(t, "2.0.0", good)
		srv := httptest.NewServer(http.NotFoundHandler())
		defer srv.Close()
		tu := newTestUpdater(t, r, srv, "1.0.0")
		if _, _, err := installOnce(t, tu); err == nil {
			t.Error("missing manifest accepted")
		}
	})
}

func assertUntouched(t *testing.T, tu *testUpdater) {
	t.Helper()
	if b, _ := os.ReadFile(tu.exe); string(b) != "v1 binary" {
		t.Errorf("executable changed: %q", b)
	}
	for _, n := range []string{updateNewName, updateOldName} {
		if _, err := os.Stat(filepath.Join(filepath.Dir(tu.exe), n)); !os.IsNotExist(err) {
			t.Errorf("%s left behind", n)
		}
	}
}

// ---- requests -----------------------------------------------------------------------

func TestHandleUpdateFlow(t *testing.T) {
	r := newRelease(t, "2.0.0", []byte("v2 binary"))
	tu := newTestUpdater(t, r, r.serve(t), "1.0.0")
	out := newOut()
	tu.handle(updateRequest(t, tu.auth, "rid-1", time.Now().UnixMilli(), "update"), out)
	fs := frames(t, tu.auth, "rid-1", out)
	if got := lastFrame(fs)["phase"]; got != "restarting" || lastFrame(fs)["version"] != "2.0.0" {
		t.Fatalf("frames: %v", fs)
	}
	for i, f := range fs {
		if int(f["n"].(float64)) != i+1 {
			t.Errorf("frame %d out of order: %v", i, f)
		}
	}
	if len(tu.execs) != 1 || tu.execs[0][0] != tu.exe || !tu.closed {
		t.Fatalf("exec calls: %v closed=%v", tu.execs, tu.closed)
	}
	env := strings.Join(tu.execs[0][1:], " ")
	if !strings.Contains(env, envTrial+"=1.0.0") || strings.Contains(env, envRolledBack) {
		t.Errorf("exec environment: %s", env)
	}
	if b, _ := os.ReadFile(tu.exe); string(b) != "v2 binary" {
		t.Error("executable not swapped")
	}
}

func TestHandleExecFailureRestores(t *testing.T) {
	r := newRelease(t, "2.0.0", []byte("v2 binary"))
	tu := newTestUpdater(t, r, r.serve(t), "1.0.0")
	tu.execErr = errors.New("exec format error")
	out := newOut()
	tu.handle(updateRequest(t, tu.auth, "rid-1", time.Now().UnixMilli(), "update"), out)
	last := lastFrame(frames(t, tu.auth, "rid-1", out))
	if last["phase"] != "error" || last["end"] != true || !strings.Contains(last["msg"].(string), "exec format error") {
		t.Errorf("last frame: %v", last)
	}
	if b, _ := os.ReadFile(tu.exe); string(b) != "v1 binary" {
		t.Errorf("v1 not restored: %q", b)
	}
}

func TestHandleNoEmbeddedKey(t *testing.T) {
	r := newRelease(t, "2.0.0", []byte("v2 binary"))
	tu := newTestUpdater(t, r, r.serve(t), "1.0.0")
	tu.key = nil
	out := newOut()
	tu.handle(updateRequest(t, tu.auth, "rid-1", time.Now().UnixMilli(), "update"), out)
	last := lastFrame(frames(t, tu.auth, "rid-1", out))
	if last["phase"] != "error" || last["msg"] != "mise à jour automatique désactivée pour cet agent (aucune clé de signature intégrée)" {
		t.Errorf("answer: %v", last)
	}
	if len(tu.execs) != 0 {
		t.Error("exec attempted without a key")
	}
	assertUntouched(t, tu)
}

func TestHandleRejectsBadRequests(t *testing.T) {
	r := newRelease(t, "2.0.0", []byte("v2 binary"))
	tu := newTestUpdater(t, r, r.serve(t), "1.0.0")
	out := newOut()
	now := time.Now().UnixMilli()

	wrong := make([]byte, 32)
	rand.Read(wrong)
	tu.handle(updateRequest(t, wrong, "a", now, "update"), out) // boxed under another key
	tu.handle(updateRequest(t, tu.auth, "b", now-6*60_000, "update"), out)
	tu.handle(updateRequest(t, tu.auth, "c", now+6*60_000, "update"), out)
	tu.handle(updateRequest(t, tu.auth, "d", now, "format-disk"), out)
	// Same box presented with another request id or another timestamp: the AAD no longer matches.
	m := updateRequest(t, tu.auth, "e", now, "update")
	m.Rid = "e2"
	tu.handle(m, out)
	m = updateRequest(t, tu.auth, "f", now, "update")
	m.Ts = json.RawMessage(strconv.FormatInt(now+1, 10))
	tu.handle(m, out)
	if n := len(out.ch); n != 0 || len(tu.execs) != 0 {
		t.Errorf("%d frames, %d exec for requests that must be ignored", n, len(tu.execs))
	}
	assertUntouched(t, tu)
}

func TestHandleReplayRefused(t *testing.T) {
	r := newRelease(t, "2.0.0", []byte("v2 binary"))
	tu := newTestUpdater(t, r, r.serve(t), "1.0.0")
	tu.execErr = errors.New("stop here") // keep the first run from succeeding
	out := newOut()
	req := updateRequest(t, tu.auth, "rid-1", time.Now().UnixMilli(), "update")
	tu.handle(req, out)
	if len(frames(t, tu.auth, "rid-1", out)) == 0 {
		t.Fatal("first request not answered")
	}
	tu.handle(req, out)
	if n := len(out.ch); n != 0 {
		t.Errorf("replayed request answered with %d frames", n)
	}
	if len(tu.execs) != 1 {
		t.Errorf("exec called %d times", len(tu.execs))
	}
}

// ---- rollback ---------------------------------------------------------------------

func TestTrialDecision(t *testing.T) {
	w := 120 * time.Second
	cases := []struct {
		name      string
		connected bool
		elapsed   time.Duration
		old       bool
		want      trialAction
	}{
		{"connected early", true, 5 * time.Second, true, trialCommit},
		{"connected at the last moment", true, w - time.Second, true, trialCommit},
		{"waiting", false, 60 * time.Second, true, trialWait},
		{"just before the window", false, w - time.Nanosecond, true, trialWait},
		{"timed out", false, w, true, trialRollback},
		{"timed out much later", false, 10 * time.Minute, true, trialRollback},
		{"timed out, no old binary", false, w, false, trialStay},
	}
	for _, c := range cases {
		if got := trialDecision(c.connected, c.elapsed, w, c.old); got != c.want {
			t.Errorf("%s: got %d, want %d", c.name, got, c.want)
		}
	}
}

func TestTrialEnvironments(t *testing.T) {
	env := []string{"A=1", envTrial + "=0.1", envRolledBack + "=1", "B=2"}
	got := strings.Join(trialEnv(env, "1.0.0"), " ")
	if got != "A=1 B=2 "+envTrial+"=1.0.0" {
		t.Errorf("trialEnv: %s", got)
	}
	got = strings.Join(rollbackEnv([]string{"A=1", envTrial + "=1.0.0"}), " ")
	if got != "A=1 "+envRolledBack+"=1" {
		t.Errorf("rollbackEnv: %s", got)
	}
}

func newTestTrial(t *testing.T, window time.Duration) (*trial, *[][]string, string) {
	t.Helper()
	dir := t.TempDir()
	exe := filepath.Join(dir, "excalibash-agent")
	old := filepath.Join(dir, updateOldName)
	os.WriteFile(exe, []byte("v2 broken"), 0o755)
	os.WriteFile(old, []byte("v1 binary"), 0o755)
	var execs [][]string
	tr := &trial{
		oldVersion: "1.0.0", exe: exe, old: old, started: time.Now(), window: window, done: make(chan struct{}),
		execFn: func(a string, _ []string, env []string) error {
			execs = append(execs, append([]string{a}, env...))
			return nil
		},
		environ: func() []string { return []string{"PATH=/bin", envTrial + "=1.0.0"} },
	}
	return tr, &execs, exe
}

func TestTrialRollsBackWhenNeverConnected(t *testing.T) {
	tr, execs, exe := newTestTrial(t, 50*time.Millisecond)
	go tr.watch()
	deadline := time.Now().Add(3 * time.Second)
	for len(*execs) == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if len(*execs) != 1 {
		t.Fatal("no rollback exec")
	}
	if b, _ := os.ReadFile(exe); string(b) != "v1 binary" {
		t.Errorf("old binary not restored: %q", b)
	}
	env := strings.Join((*execs)[0][1:], " ")
	if !strings.Contains(env, envRolledBack+"=1") || strings.Contains(env, envTrial) {
		t.Errorf("rollback environment: %s", env)
	}
	if _, err := os.Stat(tr.old); !os.IsNotExist(err) {
		t.Error("old file still there after being restored")
	}
}

func TestTrialSuccessKeepsNewAndDropsOld(t *testing.T) {
	tr, execs, exe := newTestTrial(t, 100*time.Millisecond)
	go tr.watch()
	tr.succeed()
	time.Sleep(250 * time.Millisecond)
	if len(*execs) != 0 {
		t.Error("rolled back although connected")
	}
	if b, _ := os.ReadFile(exe); string(b) != "v2 broken" {
		t.Error("new binary replaced")
	}
	if _, err := os.Stat(tr.old); !os.IsNotExist(err) {
		t.Error(".old not deleted after success")
	}
	var nilTrial *trial
	nilTrial.succeed() // a normal start has no trial: must not panic
}

func TestRolledBackNote(t *testing.T) {
	t.Setenv(envRolledBack, "")
	if rolledBackNote() != "" {
		t.Error("note without rollback")
	}
	t.Setenv(envRolledBack, "1")
	if rolledBackNote() != "mise à jour annulée" {
		t.Error("note missing after a rollback")
	}
	if os.Getenv(envRolledBack) != "" {
		t.Error("marker not consumed: it would leak to the shells")
	}
}

func TestUpdateBase(t *testing.T) {
	for in, want := range map[string]string{
		"wss://eb.example/agent":        "https://eb.example",
		"ws://127.0.0.1:6767/agent":     "http://127.0.0.1:6767",
		"wss://eb.example/prefix/agent": "https://eb.example/prefix",
	} {
		if got, err := updateBase(in); err != nil || got != want {
			t.Errorf("updateBase(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
}

// ---- integration with real binaries ---------------------------------------------------

// TestIntegrationRealBinaries builds a "v2" agent carrying the test key, serves it signed, and
// updates a copy of a "v1" build up to the swap; the new binary must then run and report 2.0.0.
func TestIntegrationRealBinaries(t *testing.T) {
	if testing.Short() {
		t.Skip("builds binaries")
	}
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("go toolchain not in PATH")
	}
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	pubB64 := base64.StdEncoding.EncodeToString(pub)
	dir := t.TempDir()
	build := func(ver, out string) []byte {
		cmd := exec.Command("go", "build", "-trimpath", "-ldflags", "-s -w -X main.version="+ver+" -X main.updatePubKey="+pubB64, "-o", out, ".")
		cmd.Env = append(os.Environ(), "CGO_ENABLED=0")
		if b, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("go build %s: %v\n%s", ver, err, b)
		}
		b, _ := os.ReadFile(out)
		return b
	}
	v1 := build("1.0.0", filepath.Join(dir, "v1"))
	v2 := build("2.0.0", filepath.Join(dir, "v2"))

	r := &release{pub: pub, priv: priv, version: "2.0.0", binary: v2}
	r.setManifest(t, "2.0.0", map[string]manifestEntry{runtime.GOOS + "-" + runtime.GOARCH: entryOf(v2)})
	srv := r.serve(t)

	tu := newTestUpdater(t, r, srv, "1.0.0")
	if err := os.WriteFile(tu.exe, v1, 0o755); err != nil {
		t.Fatal(err)
	}
	out := newOut()
	tu.handle(updateRequest(t, tu.auth, "rid-int", time.Now().UnixMilli(), "update"), out)
	if last := lastFrame(frames(t, tu.auth, "rid-int", out)); last["phase"] != "restarting" {
		t.Fatalf("last frame: %v", last)
	}
	if len(tu.execs) != 1 {
		t.Fatalf("exec calls: %v", tu.execs)
	}
	// The swapped files: the executable is v2, .old is the exact v1.
	got, _ := os.ReadFile(tu.exe)
	old, _ := os.ReadFile(filepath.Join(filepath.Dir(tu.exe), updateOldName))
	if string(got) != string(v2) || string(old) != string(v1) {
		t.Fatal("swap did not put v2 in place and keep v1 as .old")
	}
	// What exec would start really is version 2.0.0, and still carries the key.
	cmd := exec.Command(tu.exe, "--version")
	b, err := cmd.Output()
	if err != nil || strings.TrimSpace(string(b)) != "2.0.0" {
		t.Errorf("new binary reports %q (%v)", b, err)
	}
}
