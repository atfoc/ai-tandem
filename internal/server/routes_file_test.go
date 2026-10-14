package server

import (
	"encoding/json"
	"os"
	"slices"
	"testing"
)

// The desktop app's connection module checks a call against desktop/conn/routes.json. It must hold exactly the
// client API of this server, in the same order.
func TestClientRoutesFile(t *testing.T) {
	t.Parallel()
	raw, err := os.ReadFile("../../desktop/conn/routes.json")
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("desktop/conn/routes.json: %v", err)
	}
	if !slices.Equal(got, ClientRoutes) {
		t.Fatalf("desktop/conn/routes.json:\n%v\nwant ClientRoutes:\n%v", got, ClientRoutes)
	}
}
