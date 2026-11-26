package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeShell is a session source with a fixed working directory (local) or none (remote).
type fakeShell struct{ dir string }

func (f *fakeShell) Read([]byte) (int, error)    { select {} }
func (f *fakeShell) Write(p []byte) (int, error) { return len(p), nil }
func (f *fakeShell) resize(uint16, uint16)       {}
func (f *fakeShell) kill()                       {}
func (f *fakeShell) wait() int                   { return 0 }
func (f *fakeShell) close()                      {}
func (f *fakeShell) pid() int                    { return 1 }
func (f *fakeShell) describe() string            { return "fake" }
func (f *fakeShell) cwd() (string, error)        { return f.dir, nil }

type remoteShell struct{ fakeShell }

// cwd is hidden: a remote session has no local working directory.
func (r *remoteShell) cwd() {}

type fileEnv struct {
	t   *testing.T
	m   *manager
	out *outbox
	key []byte
	dir string
}

func newFileEnv(t *testing.T) *fileEnv {
	t.Helper()
	auth := make([]byte, 32)
	rand.Read(auth)
	m := newManagerWithAuth(auth)
	out := &outbox{ch: make(chan []byte, 256), done: make(chan struct{})}
	m.attach(out)
	key := make([]byte, 32)
	rand.Read(key)
	dir := t.TempDir()
	m.sessions["t1"] = &session{id: "t1", src: &fakeShell{dir: dir}, key: key, gen: "g"}
	m.sessions["r1"] = &session{id: "r1", src: &remoteShell{}, key: key, gen: "g"}
	return &fileEnv{t: t, m: m, out: out, key: key, dir: dir}
}

func (e *fileEnv) frame(term, rid string, ts int64, op map[string]any) message {
	pt, _ := json.Marshal(op)
	d, err := box(e.key, pt, "eb:file-req:"+term+":"+rid+":"+strconv.FormatInt(ts, 10))
	if err != nil {
		e.t.Fatal(err)
	}
	return message{T: "file", ID: term, Rid: rid, Ts: json.RawMessage(strconv.FormatInt(ts, 10)), D: b64.EncodeToString(d)}
}

var ridCounter int

func (e *fileEnv) send(op map[string]any) string {
	ridCounter++
	rid := fmt.Sprintf("rid-%d-%s", ridCounter, randomID(6))
	e.m.files.handle(e.frame("t1", rid, now(), op), e.out)
	return rid
}

// next waits for the next answer frame and opens it.
func (e *fileEnv) next() (message, map[string]any) {
	e.t.Helper()
	select {
	case b := <-e.out.ch:
		var m message
		if err := json.Unmarshal(b, &m); err != nil {
			e.t.Fatal(err)
		}
		if m.T != "file.res" {
			return e.next()
		}
		d, _ := b64.DecodeString(m.D)
		pt, err := unbox(e.key, d, "eb:file-res:"+m.ID+":"+m.Rid+":"+strconv.Itoa(*m.N))
		if err != nil {
			e.t.Fatalf("answer does not authenticate: %v", err)
		}
		var body map[string]any
		json.Unmarshal(pt, &body)
		return m, body
	case <-time.After(5 * time.Second):
		e.t.Fatal("no answer")
	}
	return message{}, nil
}

func (e *fileEnv) silent() bool {
	select {
	case <-e.out.ch:
		return false
	case <-time.After(300 * time.Millisecond):
		return true
	}
}

func (e *fileEnv) upload(name string, content []byte, extra map[string]any) map[string]any {
	e.t.Helper()
	xfer := "x" + randomID(8)
	op := map[string]any{"op": "put", "xfer": xfer, "name": name, "size": len(content)}
	for k, v := range extra {
		op[k] = v
	}
	e.send(op)
	if _, body := e.next(); body["error"] != nil {
		return body
	}
	h := sha256.New()
	n := 0
	for off := 0; off < len(content); off += fileChunk {
		part := content[off:min(off+fileChunk, len(content))]
		h.Write(part)
		e.send(map[string]any{"op": "chunk", "xfer": xfer, "n": n, "data": b64.EncodeToString(part)})
		if _, body := e.next(); body["error"] != nil {
			return body
		}
		n++
	}
	e.send(map[string]any{"op": "end", "xfer": xfer, "sha256": hex.EncodeToString(h.Sum(nil))})
	_, body := e.next()
	return body
}

func TestFilePutRoundtrip(t *testing.T) {
	e := newFileEnv(t)
	content := make([]byte, 2*fileChunk+777)
	rand.Read(content)
	body := e.upload("données.bin", content, nil)
	if body["ok"] != true || body["path"] != filepath.Join(e.dir, "données.bin") {
		t.Fatalf("upload: %v", body)
	}
	got, err := os.ReadFile(filepath.Join(e.dir, "données.bin"))
	if err != nil || string(got) != string(content) {
		t.Fatalf("content differs (%v)", err)
	}
	if info, _ := os.Stat(filepath.Join(e.dir, "données.bin")); info.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", info.Mode())
	}
	entries, _ := os.ReadDir(e.dir)
	if len(entries) != 1 {
		t.Fatalf("leftover part file: %v", entries)
	}

	// A wrong hash is refused and leaves nothing behind.
	xfer := "x" + randomID(8)
	e.send(map[string]any{"op": "put", "xfer": xfer, "name": "bad.bin", "size": 3})
	e.next()
	e.send(map[string]any{"op": "chunk", "xfer": xfer, "n": 0, "data": b64.EncodeToString([]byte("abc"))})
	e.next()
	e.send(map[string]any{"op": "end", "xfer": xfer, "sha256": strings.Repeat("0", 64)})
	if _, b := e.next(); b["error"] == nil {
		t.Fatal("bad hash accepted")
	}
	time.Sleep(100 * time.Millisecond)
	if entries, _ := os.ReadDir(e.dir); len(entries) != 1 {
		t.Fatalf("part file kept after failure: %v", entries)
	}
}

func TestFilePutOverwrite(t *testing.T) {
	e := newFileEnv(t)
	path := filepath.Join(e.dir, "a.txt")
	os.WriteFile(path, []byte("old"), 0o640)
	body := e.upload("a.txt", []byte("new"), nil)
	if body["code"] != "exists" {
		t.Fatalf("overwrite not refused: %v", body)
	}
	if b, _ := os.ReadFile(path); string(b) != "old" {
		t.Fatal("existing file modified")
	}
	if body := e.upload("a.txt", []byte("new"), map[string]any{"overwrite": true}); body["ok"] != true {
		t.Fatalf("overwrite: %v", body)
	}
	if b, _ := os.ReadFile(path); string(b) != "new" {
		t.Fatal("not overwritten")
	}
	if info, _ := os.Stat(path); info.Mode().Perm() != 0o640 {
		t.Fatalf("mode of the replaced file not kept: %v", info.Mode())
	}
}

func TestFileBadNames(t *testing.T) {
	e := newFileEnv(t)
	for _, name := range []string{"../x", "a/b", "a\x00b", "..", ".", "", "a\\b", strings.Repeat("é", 200)} {
		if body := e.upload(name, []byte("x"), nil); body["error"] == nil {
			t.Errorf("name %q accepted", name)
		}
	}
	if body := e.upload("x", nil, map[string]any{"size": maxFileSize + 1}); body["error"] == nil {
		t.Error("oversized upload accepted")
	}
	if entries, _ := os.ReadDir(e.dir); len(entries) != 0 {
		t.Fatalf("files created: %v", entries)
	}
	// Chunks out of sequence or past the announced size abort the upload.
	xfer := "x" + randomID(8)
	e.send(map[string]any{"op": "put", "xfer": xfer, "name": "s", "size": 2})
	e.next()
	e.send(map[string]any{"op": "chunk", "xfer": xfer, "n": 1, "data": b64.EncodeToString([]byte("a"))})
	if _, b := e.next(); b["error"] == nil {
		t.Fatal("out-of-order chunk accepted")
	}
}

func TestFileRemoteRefused(t *testing.T) {
	e := newFileEnv(t)
	e.m.files.handle(e.frame("r1", "rid-remote", now(), map[string]any{"op": "ls"}), e.out)
	_, body := e.next()
	if s, _ := body["error"].(string); !strings.Contains(s, "shell local") {
		t.Fatalf("remote session not refused: %v", body)
	}
}

func TestFileReplayAndForgery(t *testing.T) {
	e := newFileEnv(t)
	os.WriteFile(filepath.Join(e.dir, "f"), []byte("x"), 0o600)
	f := e.frame("t1", "rid-replay", now(), map[string]any{"op": "ls"})
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); e.m.files.handle(f, e.out) }()
	}
	wg.Wait()
	e.next()
	if !e.silent() {
		t.Fatal("replayed frame answered more than once")
	}
	e.m.files.handle(f, e.out)
	if !e.silent() {
		t.Fatal("sequential replay answered")
	}
	// A forged frame does not burn the id of the genuine one.
	g := e.frame("t1", "rid-forged", now(), map[string]any{"op": "ls"})
	bad := g
	bad.D = b64.EncodeToString(make([]byte, 64))
	e.m.files.handle(bad, e.out)
	e.m.files.handle(g, e.out)
	e.next()
	// Stale frames are dropped.
	e.m.files.handle(e.frame("t1", "rid-old", now()-int64(10*time.Minute/time.Millisecond), map[string]any{"op": "ls"}), e.out)
	if !e.silent() {
		t.Fatal("stale frame answered")
	}
	// A frame boxed for another terminal id does not authenticate here.
	other := e.frame("t1", "rid-x", now(), map[string]any{"op": "ls"})
	other.ID = "r1"
	e.m.files.handle(other, e.out)
	if !e.silent() {
		t.Fatal("frame replayed on another terminal")
	}
}

func TestFileLsAndGet(t *testing.T) {
	e := newFileEnv(t)
	content := make([]byte, 3*fileChunk+5)
	rand.Read(content)
	os.WriteFile(filepath.Join(e.dir, "big.bin"), content, 0o600)
	os.WriteFile(filepath.Join(e.dir, "empty"), nil, 0o600)
	os.Mkdir(filepath.Join(e.dir, "sub"), 0o700)

	e.send(map[string]any{"op": "ls"})
	_, body := e.next()
	entries, _ := body["entries"].([]any)
	if body["cwd"] != e.dir || len(entries) != 3 || entries[0].(map[string]any)["name"] != "sub" {
		t.Fatalf("ls: %v", body)
	}

	get := func(path string) (data []byte, last map[string]any) {
		xfer := "x" + randomID(8)
		rid := e.send(map[string]any{"op": "get", "xfer": xfer, "path": path})
		for {
			m, b := e.next()
			if m.Rid != rid {
				t.Fatal("answer on another rid")
			}
			if s, ok := b["data"].(string); ok {
				d, _ := b64.DecodeString(s)
				data = append(data, d...)
			}
			e.send(map[string]any{"op": "ack", "xfer": xfer, "n": *m.N + 1})
			if m.End {
				return data, b
			}
		}
	}
	data, last := get("big.bin")
	sum := sha256.Sum256(content)
	if string(data) != string(content) || last["sha256"] != hex.EncodeToString(sum[:]) {
		t.Fatalf("get differs (%d bytes): %v", len(data), last)
	}
	if data, last = get("empty"); len(data) != 0 || last["error"] != nil {
		t.Fatalf("empty get: %v", last)
	}
	if _, last = get("sub"); last["error"] == nil {
		t.Fatal("directory download accepted")
	}
	if _, last = get("missing"); last["error"] == nil {
		t.Fatal("missing file download accepted")
	}
}
