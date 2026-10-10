package boardapi

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
)

// maxImageBase64 is the largest image, as base64 text, that is passed on to an agent. The page
// refuses a picture that is too large for its own limits; this cap is the server's own guard
// against a page (or a far server) that sends far more.
const maxImageBase64 = 24 << 20

// Image is a picture a board tool returns next to its text. Data is base64 without a data: prefix.
type Image struct {
	MimeType string
	Data     string
}

// ToolResult is the result of one board tool: the text for the agent, whether it is an error,
// and for a tool that draws, the picture. An error never carries an image.
type ToolResult struct {
	Text  string
	IsErr bool
	Image *Image
}

func textResult(text string, isErr bool) ToolResult { return ToolResult{Text: text, IsErr: isErr} }

func errResult(text string) ToolResult { return ToolResult{Text: text, IsErr: true} }

// imageMimeTypes are the picture types an agent is handed.
var imageMimeTypes = map[string]bool{"image/png": true, "image/jpeg": true, "image/webp": true}

// pageResult reads the page's answer to a tool call. A JSON string is the text. An object with a
// string "text" is {"text", "image"?: {"mimeType", "data"}}. Anything else is returned as its raw
// JSON text, as it always was. A malformed or oversize image is an error result, never an image.
func pageResult(tool string, out json.RawMessage) ToolResult {
	var text string
	if json.Unmarshal(out, &text) == nil {
		return textResult(text, false)
	}
	var obj struct {
		Text  *string         `json:"text"`
		Image json.RawMessage `json:"image"`
	}
	if json.Unmarshal(out, &obj) != nil || obj.Text == nil {
		return textResult(string(out), false)
	}
	if len(obj.Image) == 0 || string(obj.Image) == "null" {
		return textResult(*obj.Text, false)
	}
	var img struct {
		MimeType *string `json:"mimeType"`
		Data     *string `json:"data"`
	}
	if json.Unmarshal(obj.Image, &img) != nil {
		return errResult(tool + ": the page sent an image that is not an object")
	}
	if img.Data != nil && len(*img.Data) > maxImageBase64 {
		return errResult(fmt.Sprintf("%s: the image is larger than %d MB; ask for a smaller scope or scale", tool, maxImageBase64>>20))
	}
	switch {
	case img.MimeType == nil || !imageMimeTypes[*img.MimeType]:
		return errResult(tool + ": the page sent an image of an unsupported type")
	case img.Data == nil || *img.Data == "":
		return errResult(tool + ": the page sent an image without data")
	}
	if _, err := base64.StdEncoding.DecodeString(*img.Data); err != nil {
		return errResult(tool + ": the page sent an image that is not valid base64")
	}
	return ToolResult{Text: *obj.Text, Image: &Image{MimeType: *img.MimeType, Data: *img.Data}}
}

// content is the MCP content of the result: the text part first, then the image part if any.
func (r ToolResult) content() []map[string]any {
	parts := []map[string]any{{"type": "text", "text": r.Text}}
	if r.Image != nil && !r.IsErr {
		parts = append(parts, map[string]any{"type": "image", "data": r.Image.Data, "mimeType": r.Image.MimeType})
	}
	return parts
}
