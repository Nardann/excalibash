VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
# Public release key (base64 of the 32 raw bytes, from `excalibash-sign keygen`). Without it the
# agent cannot update itself (see docs/RELEASE.md).
UPDATE_PUBKEY ?=
LDFLAGS := -s -w -X main.version=$(VERSION) -X main.updatePubKey=$(UPDATE_PUBKEY)
DIST ?= dist
TARGETS ?= linux/amd64 linux/arm64 darwin/amd64 darwin/arm64

.PHONY: build dist test clean

build:
	CGO_ENABLED=0 go build -trimpath -ldflags "$(LDFLAGS)" -o excalibash-agent .

dist:
	@mkdir -p $(DIST)
	@for t in $(TARGETS); do \
		os=$${t%/*}; arch=$${t#*/}; \
		echo "→ $(DIST)/excalibash-agent-$$os-$$arch"; \
		CGO_ENABLED=0 GOOS=$$os GOARCH=$$arch go build -trimpath -ldflags "$(LDFLAGS)" \
			-o $(DIST)/excalibash-agent-$$os-$$arch . || exit 1; \
	done

test:
	go test ./...

clean:
	rm -rf dist excalibash-agent
