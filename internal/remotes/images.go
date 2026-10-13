package remotes

// The images of a chat of a section. The image store is that server's, as the chat and its
// draft are: this server keeps no image. An upload is passed on with its bytes and answered as
// that server answers. A fetch is never handed on as it came: of that server's answer only the
// bytes are taken, and the type is the one this server finds from them, so that no other server
// can have this one serve a page of its own making from the app's origin.
//
// Both calls carry megabytes and get Limits.Image, as a board's drawing gets Limits.Scene.
// Neither is ended by anything but its limit, the page that asked and Close: a page that goes
// away ends its upload, and nothing of a cut upload is kept there.

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"regexp"

	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/servers"
)

// Picture is an image of a chat of a section as this server gives it to a page: the bytes that
// server answered with, and the type this server found from them, one of model.ImageTypes.
type Picture struct {
	Type string
	Data []byte
}

// ErrImageID is the cause of the refusal of an image id of another form (400 image_id).
var ErrImageID = errors.New("an image id is 64 lower-case hex digits")

var imageID = regexp.MustCompile(`^[0-9a-f]{64}$`)

// imageType is the type of the image b is, found from its first bytes alone: one of
// model.ImageTypes, "" for anything else.
func imageType(b []byte) string {
	switch {
	case bytes.HasPrefix(b, []byte("\x89PNG\r\n\x1a\n")):
		return "image/png"
	case bytes.HasPrefix(b, []byte("\xff\xd8\xff")):
		return "image/jpeg"
	case bytes.HasPrefix(b, []byte("GIF87a")), bytes.HasPrefix(b, []byte("GIF89a")):
		return "image/gif"
	case len(b) >= 12 && string(b[:4]) == "RIFF" && string(b[8:12]) == "WEBP":
		return "image/webp"
	}
	return ""
}

// imageCall passes an image call on to the entry's server, within Limits.Image; a body that is
// not nil is sent as stated, the type its upload said it is. A nil error means that rep is the
// server's answer, whatever its status but 401. The others are those of every call that is
// passed on: 404 no_server, 503 server_unreachable (nothing was sent, or the secret is not
// accepted), 504 no_answer and 502 bad_answer for an answer above the size limit of package
// servers.
func (r *Relay) imageCall(ctx context.Context, entry, method, path, stated string, body []byte) (servers.Reply, *Error) {
	if e := r.Ready(entry); e != nil {
		return servers.Reply{}, e
	}
	rep, err := r.callAs(ctx, entry, method, path, stated, body, r.o.Limits.Image)
	switch {
	case err != nil:
		return rep, r.unmade(entry, err)
	case rep.Status == http.StatusUnauthorized:
		return rep, r.unreachable(entry)
	}
	return rep, nil
}

// UploadImage serves POST …/chats/{id}/images?name= for a chat of the section entry: the upload
// is passed on, data being its bytes, stated its Content-Type and name what the page calls it,
// and the answer is that server's: the image as a draft holds it, or its refusal with its code
// (413 image_too_large, 415 image_type, 409 image_cap, 404 not_found). That server finds the
// type from the bytes; this one does not look at them. An upload that cannot be made is answered
// as imageCall says.
func (r *Relay) UploadImage(ctx context.Context, entry, chat, name, stated string, data []byte) Reply {
	if data == nil {
		data = []byte{} // an upload of nothing is an upload too: that server refuses it
	}
	rep, e := r.imageCall(ctx, entry, http.MethodPost, chatPath(chat, "/images")+query("name", name), stated, data)
	if e != nil {
		return e.Reply()
	}
	return r.handed(entry, rep)
}

// Image serves GET …/chats/{id}/images/{image} for a chat of the section entry: the image as
// this server gives it to a page, to be served under this server's own headers. The id is
// checked for its form before anything is sent (400 image_id). Of an answer of 200 only the
// bytes are taken: they must be at most model.ImageMaxBytes and one of model.ImageTypes by what
// they are, whatever type the answer claims; anything else is 502 bad_answer. An answer that is
// a refusal is given as this server's own error with that server's status, code and sentence,
// and nothing else of it. A fetch that cannot be made is answered as imageCall says.
func (r *Relay) Image(ctx context.Context, entry, chat, image string) (Picture, *Error) {
	if !imageID.MatchString(image) {
		return Picture{}, &Error{Status: http.StatusBadRequest, Code: "image_id", Text: ErrImageID.Error(), cause: ErrImageID}
	}
	rep, e := r.imageCall(ctx, entry, http.MethodGet, chatPath(chat, "/images/"+image), "", nil)
	switch {
	case e != nil:
		return Picture{}, e
	case rep.Status >= 400:
		return Picture{}, r.errorOf(entry, rep)
	case rep.Status != http.StatusOK || len(rep.Body) > model.ImageMaxBytes:
		return Picture{}, r.badAnswer(entry)
	}
	typ := imageType(rep.Body)
	if typ == "" {
		return Picture{}, r.badAnswer(entry)
	}
	return Picture{Type: typ, Data: rep.Body}, nil
}

// errorOf is an answer that is no success as an *Error: the server's status, code and sentence.
func (r *Relay) errorOf(entry string, rep servers.Reply) *Error {
	s := saidIn(rep)
	if s.Error == "" {
		s.Error = fmt.Sprintf("%s answered with status %d.", r.name(entry), rep.Status)
	}
	return &Error{Status: rep.Status, Code: s.Code, Text: s.Error}
}
