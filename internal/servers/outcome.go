package servers

// MinFeatureLevel is the lowest hello "featureLevel" this server connects to. The field is an
// integer; a missing one counts as 0.
const MinFeatureLevel = 1

// The paths asked of a remote server.
const (
	HelloPath  = "/api/hello"
	StatePath  = "/api/state"
	StreamPath = "/api/events"
)

// Outcome is how a test of a connection ended: one code per row of the test's table.
type Outcome string

const (
	OutcomeBadAddress    Outcome = "bad_address"
	OutcomeRefused       Outcome = "refused"
	OutcomeNameNotFound  Outcome = "name_not_found"
	OutcomeNoRoute       Outcome = "no_route"
	OutcomeTLSTimeout    Outcome = "tls_timeout"
	OutcomeNotHTTPS      Outcome = "not_https"
	OutcomeFingerprint   Outcome = "fingerprint"
	OutcomeCertChanged   Outcome = "cert_changed"
	OutcomeCertName      Outcome = "cert_name"
	OutcomeCertExpired   Outcome = "cert_expired"
	OutcomeSelfSigned    Outcome = "self_signed"
	OutcomeCertUntrusted Outcome = "cert_untrusted" // a fallback: no row of the plan's table
	OutcomeTLSError      Outcome = "tls_error"      // a fallback
	OutcomeSecretRefused Outcome = "secret_refused"
	OutcomeBadHost       Outcome = "bad_host"
	OutcomeNotAIWB       Outcome = "not_aiwb"
	OutcomeTooOld        Outcome = "too_old"
	OutcomeIsLocal       Outcome = "is_local"
	OutcomeDuplicate     Outcome = "duplicate"
	OutcomeAnotherServer Outcome = "another_server"
	OutcomeNoAnswer      Outcome = "no_answer" // a fallback; step 4 or 5
	OutcomeConnected     Outcome = "connected"
	OutcomeNoState       Outcome = "no_state"
)

// outcomes is the table: every outcome with the step it ends and its message to the user. The
// message of duplicate is followed by the other entry's name; no_answer also ends step 5.
var outcomes = []struct {
	outcome Outcome
	step    int
	message string
}{
	{OutcomeBadAddress, 1, "Not a valid https address"},
	{OutcomeRefused, 2, "Nothing listens there: is remote access set up on that machine?"},
	{OutcomeNameNotFound, 2, "Name not found"},
	{OutcomeNoRoute, 2, "No answer: is the VPN up?"},
	{OutcomeTLSTimeout, 3, "No answer: is the VPN up, and does a firewall on the server's machine let the port through?"},
	{OutcomeNotHTTPS, 3, "Not HTTPS: this may be the server's local port"},
	{OutcomeFingerprint, 3, "Compare this fingerprint with the one shown on the other machine, then accept it"},
	{OutcomeCertChanged, 3, "Certificate changed"},
	{OutcomeCertName, 3, "The certificate is not for this name"},
	{OutcomeCertExpired, 3, "The certificate has expired"},
	{OutcomeSelfSigned, 3, "Self-signed certificate: tick the box"},
	{OutcomeCertUntrusted, 3, "The certificate is not trusted"},
	{OutcomeTLSError, 3, "The secure connection failed"},
	{OutcomeSecretRefused, 4, "Secret not accepted"},
	{OutcomeBadHost, 4, "The server does not know this name: run set-up there with it"},
	{OutcomeNotAIWB, 4, "Something else answers there"},
	{OutcomeTooOld, 4, "Server too old: update it on that machine"},
	{OutcomeIsLocal, 4, "This is the local server"},
	{OutcomeDuplicate, 4, "Already added as"},
	{OutcomeAnotherServer, 4, "Another server answers at this address"},
	{OutcomeNoAnswer, 4, "No answer from the server"},
	{OutcomeConnected, 5, "Connected"},
	{OutcomeNoState, 5, "Connected, but the server's state could not be read"},
}

// Message is the outcome's sentence for the user; "" for a code that is not in the table.
func (o Outcome) Message() string {
	for _, row := range outcomes {
		if row.outcome == o {
			return row.message
		}
	}
	return ""
}

// Step is the step of the test the outcome ends, 1 to 5; 0 for a code that is not in the table.
func (o Outcome) Step() int {
	for _, row := range outcomes {
		if row.outcome == o {
			return row.step
		}
	}
	return 0
}
