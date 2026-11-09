package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// The MCP listener on the Docker bridge (plan D18). A Claude account's claude runs in a Docker
// container and reaches the MCP listener at http://host.docker.internal:<port>/mcp. Docker
// Desktop (macOS, Windows) brings that to the loopback listener; on Linux host.docker.internal is
// the bridge gateway (--add-host host.docker.internal:host-gateway, e.g. 172.17.0.1), so there the
// MCP handler is served on that address too, at the same port. Docker may come up after the
// server, and the gateway may change when it restarts: the bridge looks again every
// mcpBridgeEvery.

const (
	mcpBridgeEvery         = 30 * time.Second
	mcpBridgeLookupTimeout = 5 * time.Second
)

// startMCPBridge serves h on the Docker bridge gateway at port, on Linux; elsewhere it does
// nothing. It runs for the process's lifetime: the MCP listener is never closed either, the
// server ends by exiting.
func startMCPBridge(dockerBin string, port int, h http.Handler) {
	startMCPBridgeOn(runtime.GOOS, dockerBin, port, h, nil)
}

// startMCPBridgeOn is startMCPBridge for the system goos, stopped when stop closes (nil = never).
// It returns the running bridge, nil when goos needs none.
func startMCPBridgeOn(goos, dockerBin string, port int, h http.Handler, stop <-chan struct{}) *mcpBridge {
	if goos != "linux" {
		return nil
	}
	b := &mcpBridge{
		lookup:  func(ctx context.Context) (string, error) { return dockerBridgeGateway(ctx, dockerBin) },
		listen:  net.Listen,
		every:   mcpBridgeEvery,
		handler: h,
		port:    port,
	}
	go b.run(stop)
	return b
}

// dockerBridgeGateway asks Docker for the gateway address of its default bridge network.
func dockerBridgeGateway(ctx context.Context, dockerBin string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, mcpBridgeLookupTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, dockerBin, "network", "inspect", "bridge",
		"--format", "{{range .IPAM.Config}}{{.Gateway}} {{end}}")
	cmd.WaitDelay = time.Second
	out, err := cmd.Output()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) && len(ee.Stderr) > 0 {
			return "", fmt.Errorf("%v: %s", err, strings.TrimSpace(string(ee.Stderr)))
		}
		return "", err
	}
	return pickGateway(string(out)), nil
}

// pickGateway is the address to bind of Docker's gateway list: the first IPv4 one, else the first
// IP; "" when there is none. Loopback and unspecified addresses are no bridge and are skipped.
func pickGateway(out string) string {
	first := ""
	for _, f := range strings.Fields(out) {
		ip := net.ParseIP(f)
		if ip == nil || ip.IsLoopback() || ip.IsUnspecified() {
			continue
		}
		if ip.To4() != nil {
			return ip.String()
		}
		if first == "" {
			first = ip.String()
		}
	}
	return first
}

// mcpBridge keeps handler served on the address lookup gives, at port.
type mcpBridge struct {
	lookup  func(ctx context.Context) (string, error) // the gateway address, "" = none
	listen  func(network, addr string) (net.Listener, error)
	every   time.Duration
	handler http.Handler
	port    int
	logf    func(format string, args ...any) // nil = log.Printf

	logged string // the state last logged
}

// bridgeServing is the bridge's server on one address.
type bridgeServing struct {
	gw   string
	srv  *http.Server
	done chan error // Serve's end
}

// run looks up the gateway now and then every b.every, until stop closes. With no gateway, or
// when listening fails, it tries again on the next tick; when serving fails it goes back to
// trying; when the gateway changes it binds the new address. It logs each change of state once.
func (b *mcpBridge) run(stop <-chan struct{}) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		select {
		case <-stop:
			cancel()
		case <-ctx.Done():
		}
	}()
	t := time.NewTicker(b.every)
	defer t.Stop()
	var cur *bridgeServing
	defer func() {
		if cur != nil {
			cur.srv.Close()
		}
	}()
	for {
		cur = b.step(ctx, cur)
		var done chan error
		if cur != nil {
			done = cur.done
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case err := <-done:
			b.state("lost:"+cur.gw, "MCP listener on the Docker bridge %s stopped: %v; trying again every %v", cur.gw, err, b.every)
			cur = nil
			select { // the next try on the next tick
			case <-ctx.Done():
				return
			case <-t.C:
			}
		}
	}
}

// step looks up the gateway and returns what serves after it: cur when it still fits, a server
// on the new address, or nil.
func (b *mcpBridge) step(ctx context.Context, cur *bridgeServing) *bridgeServing {
	gw, err := b.lookup(ctx)
	if ctx.Err() != nil {
		return cur
	}
	if err == nil {
		gw = pickGateway(gw)
	}
	if err != nil || gw == "" {
		if cur != nil {
			return cur // Docker not answering does not take the address away: keep serving
		}
		if err != nil {
			b.state("nodocker", "MCP listener on the Docker bridge: no Docker bridge yet (%v); looking again every %v", err, b.every)
		} else {
			b.state("nogateway", "MCP listener on the Docker bridge: Docker's bridge network has no gateway address; looking again every %v", b.every)
		}
		return nil
	}
	if cur != nil {
		if cur.gw == gw {
			return cur
		}
		cur.srv.Close()
		<-cur.done
		cur = nil
	}
	addr := net.JoinHostPort(gw, strconv.Itoa(b.port))
	ln, err := b.listen("tcp", addr)
	if err != nil {
		b.state("listen:"+gw, "MCP listener on the Docker bridge %s: %v; trying again every %v", addr, err, b.every)
		return nil
	}
	s := &bridgeServing{gw: gw, srv: &http.Server{Handler: b.handler}, done: make(chan error, 1)}
	go func() { s.done <- s.srv.Serve(ln) }()
	b.state("serving:"+gw, "MCP listener also on the Docker bridge: %s", addr)
	return s
}

// state logs msg when the bridge enters a state other than the one last logged.
func (b *mcpBridge) state(key, format string, args ...any) {
	if key == b.logged {
		return
	}
	b.logged = key
	logf := b.logf
	if logf == nil {
		logf = log.Printf
	}
	logf(format, args...)
}
