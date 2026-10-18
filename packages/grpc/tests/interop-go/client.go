package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"io"
	"os"
	"slices"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/interop/grpc_testing"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

func runClient(target, testCase, ca string) error {
	var transport credentials.TransportCredentials = insecure.NewCredentials()
	if ca != "" {
		pem, err := os.ReadFile(ca)
		if err != nil {
			return err
		}
		roots := x509.NewCertPool()
		if !roots.AppendCertsFromPEM(pem) {
			return fmt.Errorf("invalid CA certificate")
		}
		transport = credentials.NewTLS(&tls.Config{RootCAs: roots, ServerName: "grpc.test"})
	}
	connection, err := grpc.NewClient(target, grpc.WithTransportCredentials(transport))
	if err != nil {
		return err
	}
	defer connection.Close()
	client := grpc_testing.NewTestServiceClient(connection)
	ctx, stop := context.WithTimeout(context.Background(), 10*time.Second)
	defer stop()

	switch testCase {
	case "unary":
		response, err := client.UnaryCall(ctx, &grpc_testing.SimpleRequest{
			ResponseSize: 314159,
			Payload:      payload(271828),
		})
		if err != nil {
			return err
		}
		return checkPayload(response.GetPayload(), 314159)
	case "client-stream":
		stream, err := client.StreamingInputCall(ctx)
		if err != nil {
			return err
		}
		var total int32
		for _, size := range []int32{27182, 8, 1828, 45904} {
			if err := stream.Send(&grpc_testing.StreamingInputCallRequest{Payload: payload(size)}); err != nil {
				return err
			}
			total += size
		}
		response, err := stream.CloseAndRecv()
		if err != nil {
			return err
		}
		if response.AggregatedPayloadSize != total {
			return fmt.Errorf("aggregated payload: got %d, want %d", response.AggregatedPayloadSize, total)
		}
		return nil
	case "server-stream":
		sizes := []int32{31415, 9, 2653, 58979}
		request := &grpc_testing.StreamingOutputCallRequest{}
		for _, size := range sizes {
			request.ResponseParameters = append(request.ResponseParameters, &grpc_testing.ResponseParameters{Size: size})
		}
		stream, err := client.StreamingOutputCall(ctx, request)
		if err != nil {
			return err
		}
		for _, size := range sizes {
			response, err := stream.Recv()
			if err != nil {
				return err
			}
			if err := checkPayload(response.GetPayload(), size); err != nil {
				return err
			}
		}
		_, err = stream.Recv()
		return checkEOF(err)
	case "bidi":
		stream, err := client.FullDuplexCall(ctx)
		if err != nil {
			return err
		}
		for _, size := range []int32{31415, 9, 2653} {
			request := &grpc_testing.StreamingOutputCallRequest{
				ResponseParameters: []*grpc_testing.ResponseParameters{{Size: size}},
			}
			if err := stream.Send(request); err != nil {
				return err
			}
			response, err := stream.Recv()
			if err != nil {
				return err
			}
			if err := checkPayload(response.GetPayload(), size); err != nil {
				return err
			}
		}
		if err := stream.CloseSend(); err != nil {
			return err
		}
		_, err = stream.Recv()
		return checkEOF(err)
	case "metadata":
		binary := string([]byte{0, 10, 255, 11})
		ctx = metadata.NewOutgoingContext(ctx, metadata.Pairs("x-repeated", "first", "x-repeated", "second", "x-request-bin", binary))
		var header, trailer metadata.MD
		_, err := client.EmptyCall(ctx, &grpc_testing.Empty{}, grpc.Header(&header), grpc.Trailer(&trailer))
		if err != nil {
			return err
		}
		if !slices.Equal(header.Get("x-repeated"), []string{"first", "second"}) || !slices.Equal(header.Get("x-header-bin"), []string{binary}) {
			return fmt.Errorf("unexpected response metadata: %v", header)
		}
		if !slices.Equal(trailer.Get("x-trailer-bin"), []string{binary}) || !slices.Equal(trailer.Get("x-trailer"), []string{"finished"}) {
			return fmt.Errorf("unexpected trailing metadata: %v", trailer)
		}
		return nil
	case "status":
		details := "\t\ntest with whitespace\r\nand Unicode BMP ☺ and non-BMP 😃\t\n"
		var trailer metadata.MD
		_, err := client.UnaryCall(ctx, &grpc_testing.SimpleRequest{
			ResponseStatus: &grpc_testing.EchoStatus{Code: int32(codes.ResourceExhausted), Message: details},
		}, grpc.Trailer(&trailer))
		if status.Code(err) != codes.ResourceExhausted || status.Convert(err).Message() != details {
			return fmt.Errorf("unexpected RPC status: %v", err)
		}
		if !slices.Equal(trailer.Get("x-error"), []string{"quota"}) {
			return fmt.Errorf("missing error trailer: %v", trailer)
		}
		return nil
	case "cancel", "deadline":
		var cancel context.CancelFunc
		if testCase == "deadline" {
			ctx, cancel = context.WithTimeout(ctx, time.Second)
		} else {
			ctx, cancel = context.WithCancel(ctx)
		}
		defer cancel()
		stream, err := client.StreamingOutputCall(ctx, &grpc_testing.StreamingOutputCallRequest{})
		if err != nil {
			return err
		}
		response, err := stream.Recv()
		if err != nil {
			return err
		}
		if err := checkPayload(response.GetPayload(), 1); err != nil {
			return err
		}
		want := codes.DeadlineExceeded
		if testCase == "cancel" {
			cancel()
			want = codes.Canceled
		}
		_, err = stream.Recv()
		if status.Code(err) != want {
			return fmt.Errorf("RPC status: got %v, want %v", err, want)
		}
		return nil
	default:
		return fmt.Errorf("unknown client scenario %q", testCase)
	}
}

func payload(size int32) *grpc_testing.Payload {
	return &grpc_testing.Payload{Body: make([]byte, size)}
}

func checkPayload(value *grpc_testing.Payload, size int32) error {
	if value == nil || !bytes.Equal(value.Body, make([]byte, size)) {
		return fmt.Errorf("response payload differs from %d zero bytes", size)
	}
	return nil
}

func checkEOF(err error) error {
	if err != io.EOF {
		return fmt.Errorf("expected stream EOF, got %v", err)
	}
	return nil
}
