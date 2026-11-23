// Command buzzhub runs the BuzzHub API and serves the React front end.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/georgewitchley-dot/buzzhub/backend/internal/server"
)

func main() {
	log := slog.New(slog.NewTextHandler(os.Stdout, nil))
	cfg := server.ConfigFromEnv()
	handler, err := server.New(context.Background(), cfg, log)
	if err != nil {
		log.Error("can't start", "err", err)
		os.Exit(1)
	}
	srv := &http.Server{Addr: ":" + cfg.Port, Handler: handler, ReadHeaderTimeout: 10 * time.Second}

	go func() {
		log.Info("BuzzHub listening", "port", cfg.Port)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("server stopped", "err", err)
			os.Exit(1)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
	log.Info("BuzzHub stopped")
}
