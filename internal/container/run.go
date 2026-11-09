package container

import (
	"crypto/rand"
	"encoding/hex"
	"strings"
)

// The docker command lines the Manager runs, which the stand-in docker of the tests
// (internal/container/fakedocker) answers the same way. Every call puts the program's options
// before the command's, as written here; <name> is Name(alias).
//
//	docker version --format {{.Server.Version}}                    availability (QuickTimeout)
//	docker inspect --type container <name>...                      JSON array; "No such container" on stderr, exit 1, for a missing one
//	docker ps -a -q --no-trunc --filter label=aiwb.alias          ids of the app's containers, one per line
//	docker create <CreateArgs(spec)...>                            prints the new id
//	docker start <name>
//	docker stop -t 3 <name>
//	docker rm -f <name>
//	docker image inspect --format {{.Id}} -- <image>               exit 1, "No such image", when the image is not there
//	docker build -t <image> -                                      the default image; the Dockerfile on stdin, no context
//	docker pull -- <image>                                         any other image
//	docker exec -i [-w <dir>] [-e NAME=value]... -e AIWB_RUN=<run id> <name> /bin/sh -c <RunScript> aiwb-run <argv>...
//	docker exec -i ... <name> /bin/sh -c <RunScript> aiwb-run-tty <argv as one shell-quoted string> <argv>...
//	docker exec <name> /bin/sh -c <KillScript> aiwb-kill <run id>  (QuickTimeout)
//
// The stand-in tells the wrapper scripts apart by their $0 (RunName, RunTTYName, KillName), not
// by their text.

// The $0 of the wrapper scripts.
const (
	RunName    = "aiwb-run"     // RunScript: argv follows
	RunTTYName = "aiwb-run-tty" // RunScript with a pseudo-terminal: the quoted command, then argv
	KillName   = "aiwb-kill"    // KillScript: the run id follows
)

// RunsDir is the folder inside a container where the run wrapper records each run's process group.
const RunsDir = "/tmp/aiwb-runs"

// RunScript is the run wrapper: `/bin/sh -c RunScript aiwb-run <argv>...`, with AIWB_RUN=<run id> in
// its environment. It starts argv in a new session and process group, records the group's id in
// RunsDir/<run id>, waits for it and exits with its status; stdin and stdout pass through.
//
// docker exec's process is a process group leader, so setsid(1) forks: -w makes it wait for the
// child rather than return at once (which would end the exec). The inner sh is the session
// leader, so its pid is the group's id; it records it and execs argv in its place.
//
// As aiwb-run-tty, its first argument is argv as one shell-quoted command, which runs under
// util-linux script(1) so that it gets a pseudo-terminal (Claude's login). An image without script
// runs argv on plain pipes; one without setsid -w runs it in the exec's own group (KillScript
// still finds it by its AIWB_RUN).
const RunScript = `d=` + RunsDir + `
mkdir -p "$d" 2>/dev/null
if [ "$0" = ` + RunTTYName + ` ]; then
  q=$1; shift
  if command -v script >/dev/null 2>&1; then set -- script -qfec "$q" /dev/null; fi
fi
if command -v setsid >/dev/null 2>&1 && setsid -w true 2>/dev/null; then
  exec setsid -w /bin/sh -c 'echo $$ > "$0/$AIWB_RUN" 2>/dev/null; exec "$@"' "$d" "$@"
fi
echo $$ > "$d/$AIWB_RUN" 2>/dev/null
exec "$@"
`

// KillScript kills a run: `/bin/sh -c KillScript aiwb-kill <run id>`. It kills the process group
// recorded for the run, then every process whose environment holds AIWB_RUN=<run id> (the shells
// the run detached into sessions of their own, and orphans re-parented to the container's init),
// and forgets the run. An unknown or ended run is no error. It must not be run with AIWB_RUN set.
const KillScript = `id=$1
case $id in ''|*[!A-Za-z0-9_-]*) exit 2;; esac
f=` + RunsDir + `/$id
if [ -r "$f" ]; then
  pg=$(cat "$f" 2>/dev/null)
  case $pg in ''|*[!0-9]*) ;; *) kill -KILL -"$pg" 2>/dev/null;; esac
fi
for e in /proc/[0-9]*/environ; do
  p=${e#/proc/}; p=${p%/environ}
  [ "$p" = "$$" ] && continue
  if { tr "\0" "\n" < "$e"; } 2>/dev/null | grep -qxF "AIWB_RUN=$id"; then kill -KILL "$p" 2>/dev/null; fi
done
rm -f "$f"
exit 0
`

// NewRunID returns a new tag for a run: "r" and 16 hex digits.
func NewRunID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return "r" + hex.EncodeToString(b[:])
}

// shellQuote is argv as one command line for /bin/sh, each word in single quotes.
func shellQuote(argv []string) string {
	q := make([]string, len(argv))
	for i, a := range argv {
		q[i] = "'" + strings.ReplaceAll(a, "'", `'\''`) + "'"
	}
	return strings.Join(q, " ")
}
