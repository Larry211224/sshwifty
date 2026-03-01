package commands

import (
	"io"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

const (
	ringBufferSize         = 64 * 1024
	persistentSessionTTL   = 12 * time.Hour
	cleanupInterval        = 5 * time.Minute
)

// RingBuffer stores recent terminal output for replay on reattach.
type RingBuffer struct {
	mu   sync.Mutex
	buf  []byte
	pos  int
	full bool
}

func NewRingBuffer(size int) *RingBuffer {
	return &RingBuffer{buf: make([]byte, size)}
}

func (r *RingBuffer) Write(p []byte) {
	r.mu.Lock()
	defer r.mu.Unlock()

	for _, b := range p {
		r.buf[r.pos] = b
		r.pos++
		if r.pos >= len(r.buf) {
			r.pos = 0
			r.full = true
		}
	}
}

// Snapshot returns a copy of the buffered data in correct order.
func (r *RingBuffer) Snapshot() []byte {
	r.mu.Lock()
	defer r.mu.Unlock()

	if !r.full {
		out := make([]byte, r.pos)
		copy(out, r.buf[:r.pos])
		return out
	}

	out := make([]byte, len(r.buf))
	n := copy(out, r.buf[r.pos:])
	copy(out[n:], r.buf[:r.pos])
	return out
}

// PersistentSession holds an SSH connection that survives WebSocket disconnects.
type PersistentSession struct {
	ID          string
	Token       string
	Client      *ssh.Client
	Session     *ssh.Session
	Stdin       io.WriteCloser
	Stdout      io.Reader
	Stderr      io.Reader
	Output      *RingBuffer
	Cols        int
	Rows        int
	DetachedAt  time.Time
	ExpiresAt   time.Time
	Address     string
	User        string

	mu        sync.Mutex
	outputCh  chan []byte // nil when detached
	closed    bool
	closeOnce sync.Once
}

// Attach sets the output channel for live streaming to a WebSocket.
func (ps *PersistentSession) Attach(ch chan []byte) {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	ps.outputCh = ch
	ps.DetachedAt = time.Time{}
}

// Detach removes the output channel; output goes only to the ring buffer.
func (ps *PersistentSession) Detach() {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	ps.outputCh = nil
	ps.DetachedAt = time.Now()
}

func (ps *PersistentSession) IsAttached() bool {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	return ps.outputCh != nil
}

func (ps *PersistentSession) IsClosed() bool {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	return ps.closed
}

func (ps *PersistentSession) WriteInput(data []byte) error {
	ps.mu.Lock()
	closed := ps.closed
	ps.mu.Unlock()
	if closed {
		return io.ErrClosedPipe
	}
	_, err := ps.Stdin.Write(data)
	return err
}

func (ps *PersistentSession) WindowChange(rows, cols int) error {
	ps.mu.Lock()
	ps.Rows = rows
	ps.Cols = cols
	ps.mu.Unlock()
	return ps.Session.WindowChange(rows, cols)
}

// Close terminates the SSH session and connection.
func (ps *PersistentSession) Close() {
	ps.closeOnce.Do(func() {
		ps.mu.Lock()
		ps.closed = true
		ch := ps.outputCh
		ps.outputCh = nil
		ps.mu.Unlock()

		if ch != nil {
			close(ch)
		}
		ps.Session.Close()
		ps.Client.Close()
	})
}

// pumpOutput reads from the SSH stdout pipe, writes to ring buffer,
// and forwards to the attached WebSocket channel (if any).
func (ps *PersistentSession) pumpOutput(r io.Reader, isStderr bool) {
	buf := make([]byte, 4096)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			data := make([]byte, n)
			copy(data, buf[:n])

			ps.Output.Write(data)

			ps.mu.Lock()
			ch := ps.outputCh
			ps.mu.Unlock()

			if ch != nil {
				// Tag byte: 0x00 = stdout, 0x01 = stderr
				tag := byte(0x00)
				if isStderr {
					tag = 0x01
				}
				tagged := make([]byte, 1+len(data))
				tagged[0] = tag
				copy(tagged[1:], data)

				select {
				case ch <- tagged:
				default:
					// Drop data if channel is full; better than blocking SSH
				}
			}
		}
		if err != nil {
			ps.Close()
			return
		}
	}
}

// Start begins pumping stdout/stderr and keepalive.
func (ps *PersistentSession) Start() {
	go ps.pumpOutput(ps.Stdout, false)
	go ps.pumpOutput(ps.Stderr, true)
	go ps.keepAlive()
}

func (ps *PersistentSession) keepAlive() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		if ps.IsClosed() {
			return
		}
		_, _, err := ps.Client.SendRequest("keepalive@openssh.com", true, nil)
		if err != nil {
			ps.Close()
			return
		}
	}
}

// GlobalPersistentSessions manages all persistent sessions.
var GlobalPersistentSessions = &PersistentSessionRegistry{}

type PersistentSessionRegistry struct {
	m           sync.Map
	cleanupOnce sync.Once
}

func (r *PersistentSessionRegistry) Register(ps *PersistentSession) {
	r.m.Store(ps.ID, ps)
}

func (r *PersistentSessionRegistry) Get(id string) (*PersistentSession, bool) {
	v, ok := r.m.Load(id)
	if !ok {
		return nil, false
	}
	ps, ok := v.(*PersistentSession)
	if !ok || ps == nil {
		return nil, false
	}
	return ps, true
}

// GetByToken finds a persistent session by its reconnect token.
func (r *PersistentSessionRegistry) GetByToken(token string) (*PersistentSession, bool) {
	var found *PersistentSession
	r.m.Range(func(key, value interface{}) bool {
		ps, ok := value.(*PersistentSession)
		if ok && ps != nil && ps.Token == token && !ps.IsClosed() {
			if time.Now().Before(ps.ExpiresAt) {
				found = ps
				return false
			}
		}
		return true
	})
	return found, found != nil
}

func (r *PersistentSessionRegistry) Unregister(id string) {
	if v, ok := r.m.Load(id); ok {
		if ps, ok := v.(*PersistentSession); ok {
			ps.Close()
		}
		r.m.Delete(id)
	}
}

func (r *PersistentSessionRegistry) Cleanup() {
	now := time.Now()
	r.m.Range(func(key, value interface{}) bool {
		ps, ok := value.(*PersistentSession)
		if !ok || ps == nil {
			r.m.Delete(key)
			return true
		}
		if ps.IsClosed() || now.After(ps.ExpiresAt) {
			ps.Close()
			r.m.Delete(key)
			return true
		}
		// Clean up detached sessions that exceeded TTL
		ps.mu.Lock()
		detached := ps.outputCh == nil && !ps.DetachedAt.IsZero()
		detachedAt := ps.DetachedAt
		ps.mu.Unlock()
		if detached && now.Sub(detachedAt) > persistentSessionTTL {
			ps.Close()
			r.m.Delete(key)
		}
		return true
	})
}

func (r *PersistentSessionRegistry) StartCleanupLoop() {
	r.cleanupOnce.Do(func() {
		go func() {
			ticker := time.NewTicker(cleanupInterval)
			defer ticker.Stop()
			for range ticker.C {
				r.Cleanup()
			}
		}()
	})
}
