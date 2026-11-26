package main

import (
	"encoding/json"
	"regexp"
	"testing"
)

func TestHelloCaps(t *testing.T) {
	re := regexp.MustCompile(`^[a-z0-9._-]{1,24}$`) // what the server accepts
	seen := map[string]bool{}
	for _, c := range agentCaps {
		if !re.MatchString(c) || seen[c] {
			t.Errorf("capability %q is invalid or repeated", c)
		}
		seen[c] = true
	}
	for _, need := range []string{"files", "capture", "ifaces", "jupyter", "probe", "schema"} {
		if !seen[need] {
			t.Errorf("capability %q missing", need)
		}
	}
	b, _ := json.Marshal(message{T: "hello", Version: "v1", Caps: agentCaps})
	var back struct {
		Caps    []string `json:"caps"`
		Version string   `json:"version"`
	}
	if json.Unmarshal(b, &back) != nil || len(back.Caps) != len(agentCaps) || back.Version != "v1" {
		t.Errorf("hello does not carry version and caps: %s", b)
	}
}
