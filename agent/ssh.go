package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"net"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

// SSH client: authentication happens inside the terminal (the user types in the browser), and
// host keys are pinned on first use in a known_hosts file next to the agent's configuration.

const maxAuthTries = 3

var (
	legacyKex      = []string{ssh.InsecureKeyExchangeDH1SHA1, ssh.InsecureKeyExchangeDH14SHA1, ssh.InsecureKeyExchangeDHGEXSHA1}
	legacyHostKeys = []string{ssh.KeyAlgoRSA, ssh.InsecureKeyAlgoDSA}
	// x/crypto does not implement aes256-cbc: it is listed for completeness and ignored.
	legacyCiphers = []string{ssh.InsecureCipherAES128CBC, "aes256-cbc", ssh.InsecureCipherTripleDESCBC}
	legacyMACs    = []string{ssh.HMACSHA1}

	// configDir is where a paired agent keeps its configuration (set from --config).
	configDir    string
	knownHostsMu sync.Mutex

	errHostKey = errors.New("clé d'hôte refusée")
)

func knownHostsPath() string {
	dir := configDir
	if dir == "" {
		dir = filepath.Dir(defaultConfigPath())
	}
	return filepath.Join(dir, "known_hosts")
}

func withLegacy(base []string, on bool, extra []string) []string {
	if !on {
		return base
	}
	out := slices.Clone(base)
	for _, a := range extra {
		if !slices.Contains(out, a) {
			out = append(out, a)
		}
	}
	return out
}

func (r *remote) runSSH() int {
	conn, ok := r.dial()
	if !ok {
		return 1
	}
	defer conn.Close()
	client, ok := r.sshClient(conn, r.t)
	if !ok {
		return 1
	}
	defer client.Close()
	return r.sshShell(client)
}

// sshClient opens an SSH connection to t over conn (TCP, or a channel through a jump host):
// host key checked, login prompts in the terminal.
func (r *remote) sshClient(conn net.Conn, t target) (*ssh.Client, bool) {
	user := t.User
	for tries := 0; user == ""; tries++ {
		if tries == maxAuthTries {
			return nil, false
		}
		if len(r.t.Via) > 0 {
			r.printf("login as (%s): ", t.Host)
		} else {
			r.printf("login as: ")
		}
		line, err := r.readLine(true)
		if err != nil {
			return nil, false
		}
		if line = strings.TrimSpace(line); targetUser.MatchString(line) {
			user = line
		} else {
			r.printf("Nom d'utilisateur incorrect.\r\n")
		}
	}

	hostKeys := withLegacy(ssh.SupportedAlgorithms().HostKeys, t.LegacyHostKey, legacyHostKeys)
	var check ssh.HostKeyCallback
	if t.HostKeyCheck == "off" {
		r.printf("\x1b[33mAttention : la clé d'hôte n'est pas vérifiée (option avancée). Une interception de la connexion passerait inaperçue.\x1b[0m\r\n")
		check = ssh.InsecureIgnoreHostKey()
	} else {
		known, err := r.knownHosts()
		if err != nil {
			r.printf("Impossible d'ouvrir %s : %v\r\n", knownHostsPath(), err)
			return nil, false
		}
		hostKeys = preferKnown(known, t.addr(), conn.RemoteAddr(), hostKeys)
		check = r.tofu(known)
	}

	aborted := false
	base := ssh.SupportedAlgorithms()
	cfg := &ssh.ClientConfig{
		User:              user,
		Auth:              r.authMethods(t, user, &aborted),
		HostKeyCallback:   check,
		HostKeyAlgorithms: hostKeys,
	}
	// x/crypto's secure algorithms; its implicit defaults would also allow some SHA-1 ones.
	cfg.KeyExchanges = withLegacy(base.KeyExchanges, t.LegacyKex, legacyKex)
	cfg.Ciphers = withLegacy(base.Ciphers, t.LegacyCiphers, legacyCiphers)
	cfg.MACs = withLegacy(base.MACs, t.LegacyCiphers, legacyMACs)

	c, chans, reqs, err := ssh.NewClientConn(conn, t.addr(), cfg)
	if err != nil {
		if r.ctx.Err() == nil && !aborted {
			r.sshError(t, err)
		}
		return nil, false
	}
	return ssh.NewClient(c, chans, reqs), true
}

// sshShell runs the interactive shell of the session.
func (r *remote) sshShell(client *ssh.Client) int {
	sess, err := client.NewSession()
	if err != nil {
		r.printf("Ouverture de session SSH refusée : %v\r\n", err)
		return 1
	}
	defer sess.Close()
	sess.Stdout, sess.Stderr = r.outW, r.outW
	stdin, err := sess.StdinPipe()
	if err != nil {
		return 1
	}
	cols, rows := r.size()
	modes := ssh.TerminalModes{ssh.ECHO: 1, ssh.TTY_OP_ISPEED: 38400, ssh.TTY_OP_OSPEED: 38400}
	if err := sess.RequestPty("xterm-256color", int(rows), int(cols), modes); err != nil {
		r.printf("Terminal distant refusé : %v\r\n", err)
		return 1
	}
	windowChange := func(c, rw uint16) { _ = sess.WindowChange(int(rw), int(c)) }
	r.setResize(windowChange)
	if c, rw := r.size(); c != cols || rw != rows {
		windowChange(c, rw) // resized while the PTY was being requested
	}
	if err := sess.Shell(); err != nil {
		r.printf("Shell distant refusé : %v\r\n", err)
		return 1
	}
	go func() {
		r.pumpInput(stdin)
		stdin.Close()
	}()

	err = sess.Wait()
	r.closedBy()
	var exit *ssh.ExitError
	var missing *ssh.ExitMissingError
	switch {
	case err == nil, errors.As(err, &missing):
		return 0
	case errors.As(err, &exit):
		return exit.ExitStatus()
	default:
		return 1
	}
}

func (r *remote) sshError(t target, err error) {
	msg := err.Error()
	switch {
	case errors.Is(err, errHostKey):
		// already explained in the terminal
	case strings.Contains(msg, "no common algorithm"):
		r.printf("Négociation SSH impossible avec %s : %s\r\n", t.Host, msg)
		if !t.LegacyKex || !t.LegacyHostKey || !t.LegacyCiphers {
			r.printf("Essayer l'option “Équipement ancien” dans la configuration avancée.\r\n")
		}
	case strings.Contains(msg, "unable to authenticate"):
		r.printf("Authentification refusée par %s.\r\n", t.Host)
	default:
		r.printf("Connexion SSH impossible à %s : %s\r\n", t.addr(), msg)
	}
}

// authMethods tries the agent user's unencrypted keys, then prompts in the terminal.
// Ctrl+C at a prompt sets *aborted and skips the remaining methods.
func (r *remote) authMethods(t target, user string, aborted *bool) []ssh.AuthMethod {
	var methods []ssh.AuthMethod
	if signers := defaultSigners(); len(signers) > 0 {
		methods = append(methods, ssh.PublicKeys(signers...))
	}
	read := func(echo bool) (string, error) {
		if *aborted {
			return "", errAborted
		}
		line, err := r.readLine(echo)
		if err != nil {
			*aborted = true
		}
		return line, err
	}
	tries := 0
	refused := func() {
		if tries > 0 {
			r.printf("Accès refusé.\r\n")
		}
		tries++
	}
	password := ssh.PasswordCallback(func() (string, error) {
		if *aborted {
			return "", errAborted
		}
		refused()
		r.printf("%s@%s's password: ", user, t.Host)
		return read(false)
	})
	interactive := ssh.KeyboardInteractive(func(name, instruction string, questions []string, echos []bool) ([]string, error) {
		if *aborted {
			return nil, errAborted
		}
		if len(questions) > 0 {
			refused()
		}
		for _, s := range []string{name, instruction} {
			if s != "" {
				r.printf("%s\r\n", strings.ReplaceAll(s, "\n", "\r\n"))
			}
		}
		answers := make([]string, len(questions))
		for i, q := range questions {
			// Through jump hosts, say which host asks: a password must not go to the wrong one.
			if len(r.t.Via) > 0 {
				r.printf("[%s] ", t.Host)
			}
			r.printf("%s", q)
			a, err := read(echos[i])
			if err != nil {
				return nil, err
			}
			answers[i] = a
		}
		return answers, nil
	})
	return append(methods,
		ssh.RetryableAuthMethod(interactive, maxAuthTries),
		ssh.RetryableAuthMethod(password, maxAuthTries))
}

// defaultSigners loads ~/.ssh/id_ed25519, id_ecdsa and id_rsa when they have no passphrase.
func defaultSigners() []ssh.Signer {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	var signers []ssh.Signer
	for _, name := range []string{"id_ed25519", "id_ecdsa", "id_rsa"} {
		b, err := os.ReadFile(filepath.Join(home, ".ssh", name))
		if err != nil {
			continue
		}
		if s, err := ssh.ParsePrivateKey(b); err == nil {
			signers = append(signers, s)
		}
	}
	return signers
}

// knownHosts opens the agent's known_hosts file, creating it if needed.
func (r *remote) knownHosts() (ssh.HostKeyCallback, error) {
	path := knownHostsPath()
	knownHostsMu.Lock()
	defer knownHostsMu.Unlock()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDONLY, 0o600)
	if err != nil {
		return nil, err
	}
	f.Close()
	return knownhosts.New(path)
}

// preferKnown restricts host key algorithms to the types already pinned for addr, so that a
// server with several keys presents the one we know.
func preferKnown(known ssh.HostKeyCallback, addr string, remote net.Addr, algos []string) []string {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return algos
	}
	probe, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		return algos
	}
	var ke *knownhosts.KeyError
	if !errors.As(known(addr, remote, probe.PublicKey()), &ke) || len(ke.Want) == 0 {
		return algos
	}
	var out []string
	for _, a := range algos {
		for _, w := range ke.Want {
			if a == w.Key.Type() || (w.Key.Type() == ssh.KeyAlgoRSA && (a == ssh.KeyAlgoRSASHA256 || a == ssh.KeyAlgoRSASHA512)) {
				out = append(out, a)
				break
			}
		}
	}
	if len(out) == 0 {
		return algos
	}
	return out
}

// tofu accepts and records the key of an unknown host, and refuses a key that changed.
func (r *remote) tofu(known ssh.HostKeyCallback) ssh.HostKeyCallback {
	return func(hostname string, remote net.Addr, key ssh.PublicKey) error {
		err := known(hostname, remote, key)
		var ke *knownhosts.KeyError
		var revoked *knownhosts.RevokedError
		switch {
		case err == nil:
			return nil
		case errors.As(err, &ke) && len(ke.Want) == 0:
			if err := appendKnownHost(hostname, key); err != nil {
				r.printf("Impossible d'enregistrer la clé d'hôte dans %s : %v\r\n", knownHostsPath(), err)
				return errHostKey
			}
			r.printf("\x1b[90mPremière connexion à %s : clé d'hôte %s enregistrée.\r\nEmpreinte %s\x1b[0m\r\n", hostname, key.Type(), ssh.FingerprintSHA256(key))
			return nil
		case errors.As(err, &ke):
			w := ke.Want[0]
			r.printf("\x1b[31mATTENTION : la clé d'hôte de %s a changé, connexion refusée.\x1b[0m\r\n", hostname)
			r.printf("Empreinte attendue : %s %s\r\n", w.Key.Type(), ssh.FingerprintSHA256(w.Key))
			r.printf("Empreinte reçue    : %s %s\r\n", key.Type(), ssh.FingerprintSHA256(key))
			r.printf("Il peut s'agir d'une interception. Si le changement est légitime (équipement réinstallé), supprimer la ligne %d de %s.\r\n", w.Line, w.Filename)
			return errHostKey
		case errors.As(err, &revoked):
			r.printf("\x1b[31mClé d'hôte de %s révoquée dans %s, connexion refusée.\x1b[0m\r\n", hostname, knownHostsPath())
			return errHostKey
		default:
			return err
		}
	}
}

func appendKnownHost(hostname string, key ssh.PublicKey) error {
	knownHostsMu.Lock()
	defer knownHostsMu.Unlock()
	f, err := os.OpenFile(knownHostsPath(), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	_, err = f.WriteString(knownhosts.Line([]string{knownhosts.Normalize(hostname)}, key) + "\n")
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return err
}
