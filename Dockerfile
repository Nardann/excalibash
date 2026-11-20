# syntax=docker/dockerfile:1

# ---- Agent binaries (offered for download) ------------------------------------
FROM golang:1.24-alpine AS agent
RUN apk add --no-cache make git
WORKDIR /src
COPY agent/go.mod agent/go.sum ./
RUN go mod download
COPY agent/ ./
ARG VERSION=docker
RUN make dist VERSION=${VERSION}

# ---- Frontend -----------------------------------------------------------------
FROM node:24-alpine AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---- Server dependencies ------------------------------------------------------
FROM node:24-alpine AS server-deps
WORKDIR /src/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

# ---- Runtime ------------------------------------------------------------------
FROM node:24-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --shell /bin/bash excalibash \
 && mkdir -p /data && chown excalibash:excalibash /data

WORKDIR /app
COPY --from=server-deps /src/server/node_modules server/node_modules
COPY server/package.json server/
COPY server/src server/src
COPY --from=web /src/web/dist web/dist
COPY --from=agent /src/dist agent/dist
COPY LICENSE THIRD_PARTY_NOTICES.md ./
COPY licenses licenses

ENV NODE_ENV=production \
    PORT=6767 \
    DATA_DIR=/data

USER excalibash
EXPOSE 6767 6768
VOLUME ["/data"]
# Plain HTTP is redirected to HTTPS when TLS is on; the local check does not verify the certificate.
HEALTHCHECK --interval=30s --timeout=3s CMD NODE_TLS_REJECT_UNAUTHORIZED=0 node --no-warnings -e "fetch('http://127.0.0.1:6767/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--", "node", "--disable-warning=ExperimentalWarning", "/app/server/src/index.ts"]
