package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"os"
	"os/signal"
	"syscall"

	"google.golang.org/grpc"
	"google.golang.org/grpc/encoding/gzip"
	"google.golang.org/grpc/interop"
	"google.golang.org/grpc/interop/grpc_testing"
)

func main() {
	address := flag.String("listen", "127.0.0.1:0", "Listen address")
	compression := flag.Bool("gzip", false, "Compress responses with gzip")
	flag.Parse()

	listener, err := net.Listen("tcp", *address)
	if err != nil {
		fatal(err)
	}
	var options []grpc.ServerOption
	if *compression {
		options = append(options,
			grpc.UnaryInterceptor(func(ctx context.Context, request any, _ *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
				if err := grpc.SetSendCompressor(ctx, gzip.Name); err != nil {
					return nil, err
				}
				return handler(ctx, request)
			}),
			grpc.StreamInterceptor(func(service any, stream grpc.ServerStream, _ *grpc.StreamServerInfo, handler grpc.StreamHandler) error {
				if err := grpc.SetSendCompressor(stream.Context(), gzip.Name); err != nil {
					return err
				}
				return handler(service, stream)
			}),
		)
	}
	server := grpc.NewServer(options...)
	grpc_testing.RegisterTestServiceServer(server, interop.NewTestServer())
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		server.Stop()
	}()
	if err := json.NewEncoder(os.Stdout).Encode(map[string]string{"address": listener.Addr().String(), "grpcVersion": grpc.Version}); err != nil {
		server.Stop()
		fatal(err)
	}
	if err := server.Serve(listener); err != nil && ctx.Err() == nil {
		fatal(err)
	}
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
