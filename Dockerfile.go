# BuzzHub: Go API + React/TypeScript front end in one small image.

# 1) Build the front end
FROM node:22-alpine AS web
WORKDIR /web
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# 2) Build the Go server
FROM golang:1.24-alpine AS api
WORKDIR /src
COPY backend/go.mod backend/go.sum* ./
RUN go mod download
COPY backend/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/buzzhub ./cmd/buzzhub

# 3) Run
FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata && adduser -D -u 10001 buzzhub
WORKDIR /app
COPY --from=api /out/buzzhub /app/buzzhub
COPY --from=web /web/dist /app/client
COPY backend/migrations /app/migrations
ENV PORT=8080 STATIC_DIR=/app/client MIGRATIONS_DIR=/app/migrations
USER buzzhub
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1
ENTRYPOINT ["/app/buzzhub"]
