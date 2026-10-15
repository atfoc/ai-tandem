package server

import (
	"encoding/json"
	"os"
	"slices"
	"testing"
)

// The connection module of the apps (@aiwb/conn) checks a call against packages/conn/core/routes.json.
// It must hold exactly the client API of this server, in the same order.
func TestClientRoutesFile(t *testing.T) {
	t.Parallel()
	raw, err := os.ReadFile("../../packages/conn/core/routes.json")
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("packages/conn/core/routes.json: %v", err)
	}
	if !slices.Equal(got, ClientRoutes) {
		t.Fatalf("packages/conn/core/routes.json:\n%v\nwant ClientRoutes:\n%v", got, ClientRoutes)
	}
}
