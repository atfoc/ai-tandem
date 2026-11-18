package codex

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"ai-whiteboard/internal/agent"
)

const (
	rpcIOTimeout  = 30 * time.Second
	rpcDrainGrace = 300 * time.Millisecond
	rpcTermGrace  = time.Second
	rpcKillGrace  = time.Second
)

var errRPCClosed = errors.New("Codex app-server connection closed")

type rpcMessage struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
	Result json.RawMessage `json:"result"`
	Error  *rpcError       `json:"error"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *rpcError) Error() string { return fmt.Sprintf("%s (code %d)", e.Message, e.Code) }

type rpcWrite struct {
	line   []byte
	result chan error
}

// rpcConn exchanges newline-delimited JSON-RPC messages with one app server.
// Callbacks run in wire order and must return promptly or observe ctx when
// blocking. A request callback can queue work and reply later.
type rpcConn struct {
	cmd    *exec.Cmd
	in     io.WriteCloser
	out    *os.File
	ctx    context.Context
	cancel context.CancelCauseFunc

	onNotification func(string, json.RawMessage)
	onRequest      func(json.RawMessage, string, json.RawMessage)
	start          sync.Once
	writes         chan rpcWrite
	nextID         atomic.Int64
	pending        sync.Map // int64 -> chan rpcMessage
	done           chan struct{}
	waitErr        error // read after done closes
}

// startRPC starts the process. Reading begins at the first call or notification,
// so the caller can finish wiring up the callbacks before the handshake.
// env adds overrides to the inherited environment.
func startRPC(ctx context.Context, executable string, args []string, cwd string, env []string, onNotification func(string, json.RawMessage), onRequest func(json.RawMessage, string, json.RawMessage)) (*rpcConn, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	cmd := exec.Command(executable, args...)
	cmd.Dir = cwd
	if len(env) > 0 {
		cmd.Env = append(cmd.Environ(), env...)
	}
	// Own the stdout pipe so Wait can reap the leader even if a child holds
	// stdout open, and so a normal exit does not discard unread responses.
	out, childOut, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	defer childOut.Close()
	cmd.Stdout = childOut
	cmd.WaitDelay = rpcDrainGrace
	in, err := cmd.StdinPipe()
	if err != nil {
		out.Close()
		return nil, err
	}
	if err := agent.StartGroup(cmd); err != nil {
		in.Close()
		out.Close()
		return nil, err
	}
	lifetime, cancel := context.WithCancelCause(ctx)
	c := &rpcConn{
		cmd: cmd, in: in, out: out, ctx: lifetime, cancel: cancel,
		onNotification: onNotification, onRequest: onRequest,
		writes: make(chan rpcWrite), done: make(chan struct{}),
	}
	context.AfterFunc(lifetime, c.run)
	return c, nil
}

func (c *rpcConn) run() {
	c.start.Do(func() {
		go c.writeLoop()
		go c.supervise()
	})
}

func (c *rpcConn) readLoop() error {
	scanner := bufio.NewScanner(c.out)
	scanner.Buffer(make([]byte, 64<<10), 64<<20)
	for scanner.Scan() {
		if c.ctx.Err() != nil {
			return nil
		}
		var m rpcMessage
		if err := json.Unmarshal(scanner.Bytes(), &m); err != nil {
			return fmt.Errorf("decode Codex app-server message: %w", err)
		}
		hasID := len(m.ID) != 0 && !bytes.Equal(m.ID, []byte("null"))
		switch {
		case m.Method != "" && hasID:
			if c.onRequest != nil {
				c.onRequest(m.ID, m.Method, m.Params)
			} else {
				_ = c.reply(m.ID, nil, &rpcError{Code: -32601, Message: "method not found"})
			}
		case m.Method != "":
			if c.onNotification != nil {
				c.onNotification(m.Method, m.Params)
			}
		case hasID:
			id, err := strconv.ParseInt(string(m.ID), 10, 64)
			if err == nil {
				if ch, ok := c.pending.LoadAndDelete(id); ok {
					ch.(chan rpcMessage) <- m
				}
			}
		}
	}
	return scanner.Err()
}

func (c *rpcConn) writeLoop() {
	for {
		select {
		case <-c.ctx.Done():
			return
		case write := <-c.writes:
			_, err := c.in.Write(write.line)
			write.result <- err
			if err != nil {
				c.cancel(err)
				return
			}
		}
	}
}

func (c *rpcConn) write(ctx context.Context, message map[string]any) error {
	// The app server uses JSON-RPC framing without a jsonrpc version field.
	data, err := json.Marshal(message)
	if err != nil {
		return err
	}
	write := rpcWrite{line: append(data, '\n'), result: make(chan error, 1)}
	c.run()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-c.ctx.Done():
		return c.exitError()
	case c.writes <- write:
	}
	select {
	case err := <-write.result:
		return err
	case <-c.ctx.Done():
		return c.exitError()
	case <-ctx.Done():
		select {
		case err := <-write.result:
			return err
		default:
			// An interrupted write could leave a partial message on the stream.
			c.cancel(ctx.Err())
			return ctx.Err()
		}
	}
}

func (c *rpcConn) call(ctx context.Context, method string, params, result any) error {
	ctx, cancel := context.WithTimeout(ctx, rpcIOTimeout)
	defer cancel()
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("%s: %w", method, err)
	}
	id := c.nextID.Add(1)
	response := make(chan rpcMessage, 1)
	c.pending.Store(id, response)
	defer c.pending.Delete(id)
	message := map[string]any{"id": id, "method": method}
	if params != nil {
		message["params"] = params
	}
	if err := c.write(ctx, message); err != nil {
		return fmt.Errorf("%s: %w", method, err)
	}
	var reply rpcMessage
	select {
	case reply = <-response:
	case <-ctx.Done():
		return fmt.Errorf("%s: %w", method, ctx.Err())
	case <-c.ctx.Done():
		// The server may have sent the response immediately before exiting.
		select {
		case reply = <-response:
		default:
			return fmt.Errorf("%s: %w", method, c.exitError())
		}
	}
	if reply.Error != nil {
		return fmt.Errorf("%s: %w", method, reply.Error)
	}
	if len(reply.Result) == 0 {
		return fmt.Errorf("%s: missing Codex app-server response result", method)
	}
	if result != nil {
		if err := json.Unmarshal(reply.Result, result); err != nil {
			return fmt.Errorf("%s: decode Codex app-server response: %w", method, err)
		}
	}
	return nil
}

func (c *rpcConn) notify(method string, params any) error {
	ctx, cancel := context.WithTimeout(context.Background(), rpcIOTimeout)
	defer cancel()
	message := map[string]any{"method": method}
	if params != nil {
		message["params"] = params
	}
	return c.write(ctx, message)
}

func (c *rpcConn) reply(id json.RawMessage, result any, rpcErr error) error {
	ctx, cancel := context.WithTimeout(context.Background(), rpcIOTimeout)
	defer cancel()
	message := map[string]any{"id": id}
	if rpcErr == nil {
		message["result"] = result
	} else {
		var protocolError *rpcError
		if !errors.As(rpcErr, &protocolError) {
			protocolError = &rpcError{Code: -32603, Message: rpcErr.Error()}
		}
		message["error"] = protocolError
	}
	return c.write(ctx, message)
}

func (c *rpcConn) supervise() {
	process := make(chan error, 1)
	go func() {
		process <- c.cmd.Wait()
	}()
	reader := make(chan error, 1)
	go func() {
		reader <- c.readLoop()
	}()

	var readErr, processErr error
	var readFinished, processExited bool
	select {
	case processErr = <-process:
		processExited = true
		select {
		case readErr = <-reader:
			readFinished = true
		case <-time.After(rpcDrainGrace):
		case <-c.ctx.Done():
		}
	case readErr = <-reader:
		readFinished = true
	case <-c.ctx.Done():
	}

	cause := errors.Join(readErr, processErr)
	if cause == nil {
		cause = errRPCClosed
	}
	c.cancel(cause)
	if !processExited {
		agent.Adopt(c.cmd)
	}
	c.in.Close()
	c.out.Close()
	if !processExited && readErr == nil {
		select {
		case processErr = <-process:
			processExited = true
		case <-time.After(rpcDrainGrace):
		}
	}
	groupAlive := agent.SignalGroup(c.cmd, syscall.SIGTERM)
	agent.SignalAdopted(c.cmd, syscall.SIGTERM)
	if !processExited {
		select {
		case processErr = <-process:
			processExited = true
		case <-time.After(rpcTermGrace):
		}
	}
	if groupAlive {
		agent.SignalGroup(c.cmd, syscall.SIGKILL)
	}
	agent.SignalAdopted(c.cmd, syscall.SIGKILL)
	if !processExited {
		_ = c.cmd.Process.Kill()
		select {
		case processErr = <-process:
			processExited = true
		case <-time.After(rpcKillGrace):
			processErr = errors.New("Codex app-server did not exit after being killed")
		}
	}
	if processExited {
		agent.Exited(c.cmd)
	} else {
		go func() {
			<-process
			agent.Exited(c.cmd)
		}()
	}
	if !readFinished {
		<-reader
	}
	c.waitErr = errors.Join(readErr, processErr)
	close(c.done)
}

func (c *rpcConn) close() error {
	c.cancel(errRPCClosed)
	c.run()
	<-c.done
	return nil
}

func (c *rpcConn) err() error {
	<-c.done
	return c.waitErr
}

func (c *rpcConn) exitError() error {
	select {
	case <-c.done:
		if c.waitErr != nil {
			return c.waitErr
		}
	default:
	}
	return context.Cause(c.ctx)
}
