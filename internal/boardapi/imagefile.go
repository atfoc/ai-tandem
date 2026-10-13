package boardapi

import (
	"encoding/base64"
	"fmt"

	"ai-whiteboard/internal/agent"
)

// imageToFile turns a result with a picture into a text-only result: the picture is written to a
// file (agent.ImageFiles, which an image attached to a message of a Cursor chat goes through too)
// and its absolute path is added to the text. A Cursor agent is not handed an image part (it
// cannot take one), but it can open a file. A result without a picture is returned as it is; a
// write failure is an error result, never a silent drop.
func (r *Relay) imageToFile(tool string, res ToolResult) ToolResult {
	if res.IsErr || res.Image == nil {
		return res
	}
	data, err := base64.StdEncoding.DecodeString(res.Image.Data)
	var path string
	if err == nil {
		path, err = agent.ImageFiles{Dir: r.ImageDir, MaxAge: r.ImageMaxAge}.Write(res.Image.MimeType, data)
	}
	if err != nil {
		return errResult(fmt.Sprintf("%s: could not save the image for you to open: %v", tool, err))
	}
	return textResult(res.Text+" "+agent.ImageFileText(path, res.Image.MimeType), false)
}
