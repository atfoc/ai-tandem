package main

// The Claude accounts of the server (internal/aliases): each runs Claude Code in a Docker
// container of its own. What serve needs to set them up is here.

import (
	"log"
	"net"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/aliases"
	"ai-whiteboard/internal/boardapi"
	"ai-whiteboard/internal/claude"
	"ai-whiteboard/internal/container"
	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/prompts"
	"ai-whiteboard/internal/store"
	"ai-whiteboard/internal/usable"
)

// accountCatalogLimit bounds the model list probe of an account. The container runs when the
// probe is asked for, but the first claude start in it may be slow.
const accountCatalogLimit = 60 * time.Second

// accountsSetup is what openAccounts needs of serve.
type accountsSetup struct {
	root, home string
	docker     *container.Manager
	mcpPort    int             // the port the MCP listener is bound to
	host       *claude.Spawner // the computer's own Claude Code
	st         *store.Store
	br         *editorbridge.Bridge
	agents     *usable.Set
}

// openAccounts makes the accounts' service. It calls neither Docker nor Claude, so a Docker that
// is missing or slow does not delay the start. When it fails, the error is logged and nil is
// returned: the server runs without accounts.
func openAccounts(c accountsSetup) *aliases.Service {
	// svc is set before Ready can be called: Ready is called from the service's goroutines, which
	// start after New.
	var svc *aliases.Service
	var err error
	svc, err = aliases.New(aliases.Options{
		Root: c.root, Home: c.home, Containers: c.docker,
		ClaudeBin: aliasClaude(),
		Prompt:    prompts.Claude(),
		MCPURL:    containerMCPURL(c.mcpPort),
		Host:      c.host,
		Broadcast: c.br.Broadcast,
		// The agent list is looked at again; a change of it wakes the agents' Watch, which sends
		// the "agents" event.
		Changed: func() { c.agents.Refresh() },
		// From a goroutine of its own, which the service's Shutdown does not wait for: a probe
		// that is still making the container ready must not hold the server's end.
		Ready: func(kind model.AgentKind) {
			go probeAccountCatalog(svc, kind, c.st, c.br)
		},
	})
	if err != nil {
		log.Printf("Claude accounts: %v: the server runs without them", err)
		return nil
	}
	return svc
}

// probeAccountCatalog fetches the model list of the account kind for the pickers (plan D2), in its
// container only while that runs (RunningSpawner: a container the person stopped meanwhile is not
// started again for it). A removed account has no spawner, and nothing is done.
func probeAccountCatalog(svc *aliases.Service, kind model.AgentKind, st *store.Store, br *editorbridge.Bridge) {
	sp, _ := svc.RunningSpawner(kind).(*claude.Spawner)
	if sp == nil {
		return
	}
	refreshClaudeCatalog(kind, sp, accountCatalogLimit, st, br)
}

// aliasClaude is the claude program of the accounts' containers, as their PATH finds it: "claude",
// or the hidden test-only AIWB_TEST_ALIAS_CLAUDE override, which a test of real server processes
// sets to the stand-in claude. Like AIWB_MCP_PORT it is deliberately not a flag.
func aliasClaude() string {
	if v := strings.TrimSpace(os.Getenv("AIWB_TEST_ALIAS_CLAUDE")); v != "" {
		return v
	}
	return "claude"
}

// containerMCPURL is the MCP endpoint of the listener on port as a container reaches it: the URL
// of boardapi.Endpoint with host.docker.internal for its host.
func containerMCPURL(port int) string {
	u, err := url.Parse(boardapi.Endpoint(port))
	if err != nil {
		panic(err) // never: Endpoint makes a fixed form
	}
	u.Host = net.JoinHostPort("host.docker.internal", u.Port())
	return u.String()
}

// accountsUsage gives the usage call of each account kind (server.Server.UsageFor): a cache of
// a minute per kind, made on the first ask. The usage is read only while the account's container
// runs, as the service last saw it.
type accountsUsage struct {
	// docker is Docker's state as last looked (container.Manager.Available).
	docker func() error
	// state is the account's container as the service last saw it (aliases.ContainerView.State);
	// false: no such account.
	state func(model.AgentKind) (string, bool)
	// fetch reads the account's usage in its container.
	fetch func(model.AgentKind) (model.PlanUsage, error)

	mu     sync.Mutex
	caches map[model.AgentKind]*agent.UsageCache
}

// newAccountsUsage is the accountsUsage of svc.
func newAccountsUsage(svc *aliases.Service, docker *container.Manager) *accountsUsage {
	return &accountsUsage{
		docker: docker.Available,
		state: func(kind model.AgentKind) (string, bool) {
			for _, v := range svc.List().Aliases {
				if v.Kind == kind {
					return v.Container.State, true
				}
			}
			return "", false
		},
		fetch: func(kind model.AgentKind) (model.PlanUsage, error) {
			// Never starts the container (D24): one stopped since the state was read is ErrStopped.
			sp, _ := svc.RunningSpawner(kind).(*claude.Spawner)
			if sp == nil {
				return model.PlanUsage{}, aliases.ErrRemoved
			}
			return sp.Usage()
		},
	}
}

// For is the usage call of kind; nil when kind is no account, or a removed one.
func (u *accountsUsage) For(kind model.AgentKind) func(fresh bool) (model.PlanUsage, error) {
	if !model.IsAlias(kind) {
		return nil
	}
	if _, ok := u.state(kind); !ok {
		return nil
	}
	u.mu.Lock()
	if u.caches == nil {
		u.caches = map[model.AgentKind]*agent.UsageCache{}
	}
	c := u.caches[kind]
	if c == nil {
		c = &agent.UsageCache{Fetch: func() (model.PlanUsage, error) { return u.fetch(kind) }, TTL: time.Minute}
		u.caches[kind] = c
	}
	u.mu.Unlock()
	return func(fresh bool) (model.PlanUsage, error) {
		if err := u.docker(); err != nil {
			return model.PlanUsage{}, err
		}
		state, ok := u.state(kind)
		if !ok {
			return model.PlanUsage{}, aliases.ErrRemoved
		}
		if state != aliases.ContainerRunning {
			return model.PlanUsage{}, aliases.ErrStopped
		}
		return c.Get(fresh)
	}
}
