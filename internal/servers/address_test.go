package servers

import (
	"errors"
	"testing"
)

func TestParseAddress(t *testing.T) {
	t.Parallel()
	good := []struct{ in, address, host, port string }{
		{"https://mac.local:4748", "https://mac.local:4748", "mac.local", "4748"},
		{"HTTPS://Mac.Local:4748", "https://mac.local:4748", "mac.local", "4748"},
		{"  https://10.0.0.7:1/  ", "https://10.0.0.7:1", "10.0.0.7", "1"},
		{"https://studio:65535", "https://studio:65535", "studio", "65535"},
		{"https://a.example.com:0443", "https://a.example.com:443", "a.example.com", "443"},
	}
	for _, c := range good {
		address, host, port, err := ParseAddress(c.in)
		if err != nil || address != c.address || host != c.host || port != c.port {
			t.Errorf("ParseAddress(%q) = %q, %q, %q, %v; want %q, %q, %q", c.in, address, host, port, err, c.address, c.host, c.port)
		}
	}
	bad := []string{
		"",
		"mac.local:4748",
		"http://mac.local:4748",
		"wss://mac.local:4748",
		"https://mac.local",       // no port
		"https://mac.local:",      // an empty port
		"https://mac.local:0",     // port 0
		"https://mac.local:70000", // port above 65535
		"https://mac.local:-1",
		"https://mac.local:+80",
		"https://mac.local:port",
		"https://mac.local:4748/api", // a path
		"https://mac.local:4748//",
		"https://user@mac.local:4748", // a user
		"https://user:pw@mac.local:4748",
		"https://mac.local:4748?x=1",
		"https://mac.local:4748?",
		"https://mac.local:4748#top",
		"https://mac.local:4748#",
		"https://[::1]:4748", // IPv6
		"https://[fe80::1%25en0]:4748",
		"https://::1:4748",
		"https://:4748",
		"https://mac_local:4748",
		"https://-mac.local:4748",
		"https://mac..local:4748",
		"https://mac.local.:4748",
		"https://mac local:4748",
		"https:mac.local:4748",
	}
	for _, in := range bad {
		address, host, port, err := ParseAddress(in)
		if !errors.Is(err, ErrBadAddress) || address != "" || host != "" || port != "" {
			t.Errorf("ParseAddress(%q) = %q, %q, %q, %v; want ErrBadAddress", in, address, host, port, err)
		}
	}
}
