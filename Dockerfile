# Relay server image: Rust API + WebSocket server, with the web client baked in.
# Build:  docker build -t ghcr.io/<you>/relay-server:latest .
# Push:   docker push ghcr.io/<you>/relay-server:latest   (or ./scripts/push-image.sh)

# ---- web client ----
FROM node:22-alpine AS web
WORKDIR /app
COPY client/package.json client/package-lock.json* ./
RUN npm ci || npm install
COPY client/ ./
RUN npm run build

# ---- server ----
FROM rust:1-bookworm AS server
WORKDIR /app
# Cache dependencies separately from source.
COPY server/Cargo.toml server/Cargo.lock* ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs && cargo build --release && rm -rf src
COPY server/ ./
RUN touch src/main.rs && cargo build --release

# ---- runtime ----
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -r -u 10001 relay && mkdir -p /data/media && chown -R relay /data
COPY --from=server /app/target/release/relay-server /usr/local/bin/relay-server
COPY --from=web /app/dist /srv/web
ENV PORT=8080 MEDIA_DIR=/data/media WEB_DIR=/srv/web RUST_LOG=relay_server=info
USER relay
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD curl -fs http://localhost:8080/api/health || exit 1
CMD ["relay-server"]
