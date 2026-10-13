// The locks per chat id, which a creation with an id and a delete of that id hold.
package chats

import "sync"

// idLocks are the creation locks: one mutex per chat id, which exists only while somebody holds
// it or waits for it. Ids come from whoever holds the secret, so no entry outlives its use. The
// zero value is ready.
type idLocks struct {
	mu sync.Mutex
	m  map[string]*idLock
}

// idLock is the lock of one id; n counts its holders and waiters, under idLocks.mu.
type idLock struct {
	sync.Mutex
	n int
}

// lock takes the lock of id, waiting for whoever holds it, and returns what releases it.
func (l *idLocks) lock(id string) (unlock func()) {
	l.mu.Lock()
	if l.m == nil {
		l.m = map[string]*idLock{}
	}
	k := l.m[id]
	if k == nil {
		k = &idLock{}
		l.m[id] = k
	}
	k.n++
	l.mu.Unlock()
	k.Lock()
	return func() {
		k.Unlock()
		l.mu.Lock()
		if k.n--; k.n == 0 {
			delete(l.m, id)
		}
		l.mu.Unlock()
	}
}

// held is how many ids have a lock that is held or waited for.
func (l *idLocks) held() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.m)
}
