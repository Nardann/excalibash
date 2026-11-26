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
	"path/filepath"
	"strings"
	"syscall"
)

var version = "dev"

// activeTrial watches a process started by a self-update (nil otherwise); rolledBack is the note
// a restored agent adds to its hello.
var (
	activeTrial *trial
	rolledBack  string
)

type config struct {
	endpoint string // ws(s)://host/agent
	token    string
	name     string
	insecure bool
	pin      string // sha256//… of the server public key, replaces certificate verification
}

func main() {
	log.SetFlags(log.Ltime)
	log.SetPrefix("[agent] ")
	// First thing: a process started by an update must be able to roll back whatever happens next.
	activeTrial = startTrial()
	rolledBack = rolledBackNote()

	server := flag.String("server", os.Getenv("EXCALIBASH_SERVER"), "base URL of the Excalibash server (env EXCALIBASH_SERVER)")
	token := flag.String("token", os.Getenv("EXCALIBASH_TOKEN"), "machine token (env EXCALIBASH_TOKEN)")
	name := flag.String("name", os.Getenv("EXCALIBASH_NAME"), "display name of this machine (env EXCALIBASH_NAME, default hostname)")
	key := flag.String("key", os.Getenv("EXCALIBASH_KEY"), "machine private key, base64url (env EXCALIBASH_KEY)")
	keyFile := flag.String("key-file", "", "file containing the machine private key")
	pairCode := flag.String("pair", "", "pair this machine with a short code shown in Excalibash")
	pairOnly := flag.Bool("pair-only", false, "with --pair: save the configuration and exit (used by the installer)")
	configPath := flag.String("config", defaultConfigPath(), "where a paired agent keeps its configuration")
	insecure := flag.Bool("insecure", false, "skip TLS certificate verification")
	pinFlag := flag.String("pin", os.Getenv("EXCALIBASH_PIN"), "accept only the server certificate with this public key, sha256//<base64> as curl --pinnedpubkey (env EXCALIBASH_PIN)")
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()
	configDir = filepath.Dir(*configPath)

	if *showVersion {
		fmt.Println(version)
		return
	}
	// Arguments are visible to every local user (ps, /proc/<pid>/cmdline) and stay in shell history.
	flag.Visit(func(f *flag.Flag) {
		if f.Name == "token" || f.Name == "key" {
			log.Printf("attention : --%s se voit dans la liste des processus ; préfère EXCALIBASH_%s, --key-file ou --pair", f.Name, strings.ToUpper(f.Name))
		}
	})
	if *keyFile != "" {
		b, err := os.ReadFile(*keyFile)
		if err != nil {
			log.Fatalf("--key-file: %v", err)
		}
		*key = string(b)
	}
	if *name == "" {
		*name, _ = os.Hostname()
	}
	pin, err := parsePin(*pinFlag)
	if err != nil {
		fmt.Fprintf(os.Stderr, "--pin : %v\n", err)
		os.Exit(2)
	}

	// Three ways to get credentials: pair now, a key from the install command, or a saved pairing.
	var auth, pub []byte
	switch {
	case *pairCode != "":
		if *server == "" {
			log.Fatal("--pair needs --server")
		}
		c, err := pair(*server, *pairCode, *name, *insecure, pin)
		if err != nil {
			log.Fatalf("appairage : %v", err)
		}
		if err := saveConfig(*configPath, c); err != nil {
			log.Fatalf("cannot save %s: %v", *configPath, err)
		}
		fmt.Fprintf(os.Stderr, "  ✓ Machine appairée. Configuration enregistrée dans %s\n\n", *configPath)
		if *pairOnly {
			return
		}
		*server, *token = c.Server, c.Token
		auth, _ = b64.DecodeString(c.Auth)
		pub = pubFromB64(c.Pub)
	case *token != "" && *key != "":
		priv, err := parsePrivateKey(*key)
		if err != nil {
			log.Fatalf("invalid machine key: %v", err)
		}
		auth = machineAuthKey(priv)
		pub = priv.PublicKey().Bytes()
	default:
		c, err := loadConfig(*configPath)
		if err != nil {
			fmt.Fprintln(os.Stderr, "usage: excalibash-agent --server https://excalibash.example.com --pair <CODE>")
			fmt.Fprintln(os.Stderr, "   or: excalibash-agent --server https://excalibash.example.com --token <token> --key <key>")
			os.Exit(2)
		}
		if *server == "" {
			*server = c.Server
		}
		*token = c.Token
		auth, _ = b64.DecodeString(c.Auth)
		pub = pubFromB64(c.Pub)
		if pin, err = savedPin(pin, c); err != nil {
			log.Fatalf("%s : %v", *configPath, err)
		}
	}
	if *server == "" || len(auth) != keyLen {
		log.Fatal("missing --server or invalid machine credentials")
	}
	endpoint, err := agentEndpoint(*server)
	if err != nil {
		log.Fatalf("invalid --server: %v", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	mgr := newManagerWithAuth(auth)
	if err := mgr.update.configure(endpoint, *insecure, pin); err != nil {
		log.Fatalf("invalid --server: %v", err)
	}
	cfg := config{endpoint: endpoint, token: *token, name: *name, insecure: *insecure, pin: pin}
	log.Printf("excalibash-agent %s → %s", version, endpoint)
	if *insecure {
		log.Printf("attention : --insecure, le certificat du serveur n'est pas vérifié (le jeton de la machine peut être intercepté)")
	} else if strings.HasPrefix(endpoint, "ws://") {
		log.Printf("attention : connexion en clair (ws://), le jeton de la machine peut être intercepté ; le contenu reste chiffré de bout en bout")
	}
	if pin != "" {
		log.Printf("server key pinned: %s", pin)
	}
	if pub != nil {
		log.Printf("machine key fingerprint: %s", fingerprint(pub))
	}
	run(ctx, cfg, mgr)
	mgr.closeAll()
}

// savedPin returns the pin to use with a saved pairing: an explicit --pin overrides the saved one.
func savedPin(explicit string, c savedConfig) (string, error) {
	if explicit != "" {
		return explicit, nil
	}
	return parsePin(c.Pin)
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
