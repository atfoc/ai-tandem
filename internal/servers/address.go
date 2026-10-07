package servers

import (
	"net"
	"net/url"
	"strconv"
	"strings"

	"ai-whiteboard/internal/remote"
)

// ParseAddress reads a server's address as typed: scheme https, a host that is a DNS name or an
// IPv4 literal (remote.NormalName; no IPv6), an explicit port 1 to 65535, a path of "" or "/",
// and no user, query or fragment. address is the stored form, lower-cased "https://host:port".
// Every failure is ErrBadAddress.
func ParseAddress(s string) (address, host, port string, err error) {
	s = strings.TrimSpace(s)
	if strings.ContainsAny(s, "?#") {
		return "", "", "", ErrBadAddress
	}
	u, perr := url.Parse(s)
	if perr != nil || u.Scheme != "https" || u.Opaque != "" || u.User != nil {
		return "", "", "", ErrBadAddress
	}
	if u.Path != "" && u.Path != "/" {
		return "", "", "", ErrBadAddress
	}
	h, p, serr := net.SplitHostPort(u.Host)
	if serr != nil {
		return "", "", "", ErrBadAddress
	}
	host, ok := remote.NormalName(h)
	if !ok {
		return "", "", "", ErrBadAddress
	}
	for i := 0; i < len(p); i++ {
		if p[i] < '0' || p[i] > '9' {
			return "", "", "", ErrBadAddress
		}
	}
	n, aerr := strconv.Atoi(p)
	if aerr != nil || n < 1 || n > 65535 {
		return "", "", "", ErrBadAddress
	}
	port = strconv.Itoa(n)
	return "https://" + host + ":" + port, host, port, nil
}
