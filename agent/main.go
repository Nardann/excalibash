// Command excalibash-agent attaches a machine to an Excalibash server so that
// board users can open terminals on it.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
)

var version = "dev"

type config struct {
	endpoint string // ws(s)://host/agent
	token    string
	name     string
	insecure bool
}

func main() {
	log.SetFlags(log.Ltime)
	log.SetPrefix("[agent] ")

	server := flag.String("server", os.Getenv("EXCALIBASH_SERVER"), "base URL of the Excalibash server (env EXCALIBASH_SERVER)")
	token := flag.String("token", os.Getenv("EXCALIBASH_TOKEN"), "machine token (env EXCALIBASH_TOKEN)")
	name := flag.String("name", os.Getenv("EXCALIBASH_NAME"), "display name of this machine (env EXCALIBASH_NAME, default hostname)")
	key := flag.String("key", os.Getenv("EXCALIBASH_KEY"), "machine private key, base64url (env EXCALIBASH_KEY)")
	keyFile := flag.String("key-file", "", "file containing the machine private key")
	insecure := flag.Bool("insecure", false, "skip TLS certificate verification")
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Println(version)
		return
	}
	if *keyFile != "" {
		b, err := os.ReadFile(*keyFile)
		if err != nil {
			log.Fatalf("--key-file: %v", err)
		}
		*key = string(b)
	}
	if *server == "" || *token == "" || *key == "" {
		fmt.Fprintln(os.Stderr, "usage: excalibash-agent --server https://excalibash.example.com --token <token> --key <key>")
		os.Exit(2)
	}
	priv, err := parsePrivateKey(*key)
	if err != nil {
		log.Fatalf("invalid machine key: %v", err)
	}
	endpoint, err := agentEndpoint(*server)
	if err != nil {
		log.Fatalf("invalid --server: %v", err)
	}
	if *name == "" {
		*name, _ = os.Hostname()
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	mgr := newManager(priv)
	cfg := config{endpoint: endpoint, token: *token, name: *name, insecure: *insecure}
	log.Printf("excalibash-agent %s → %s", version, endpoint)
	log.Printf("machine key fingerprint: %s", fingerprint(priv.PublicKey().Bytes()))
	run(ctx, cfg, mgr)
	mgr.closeAll()
}

// agentEndpoint turns a base URL (http, https, ws or wss) into the /agent websocket URL.
func agentEndpoint(base string) (string, error) {
	if !strings.Contains(base, "://") {
		base = "https://" + base
	}
	u, err := url.Parse(base)
	if err != nil {
		return "", err
	}
	switch u.Scheme {
	case "http", "ws":
		u.Scheme = "ws"
	case "https", "wss":
		u.Scheme = "wss"
	default:
		return "", fmt.Errorf("unsupported scheme %q", u.Scheme)
	}
	if u.Host == "" {
		return "", fmt.Errorf("missing host")
	}
	path := strings.TrimRight(u.Path, "/")
	if !strings.HasSuffix(path, "/agent") {
		path += "/agent"
	}
	u.Path = path
	u.RawQuery = ""
	u.Fragment = ""
	return u.String(), nil
}
