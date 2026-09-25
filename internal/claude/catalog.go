package claude

import "ai-whiteboard/internal/model"

var efforts = []string{"low", "medium", "high", "xhigh", "max"}

// Catalog is Claude's static model list, served to every client.
var Catalog = model.Catalog{
	Models: []model.CatalogModel{
		{ID: "sonnet", Label: "Sonnet 5", Note: "Balanced · 1M context", Efforts: efforts, ContextWindow: 1_000_000},
		{ID: "opus", Label: "Opus 5.5", Note: "Most capable · 1M context", Efforts: efforts, ContextWindow: 1_000_000},
		{ID: "haiku", Label: "Haiku 4.5", Note: "Fastest · 200k context", ContextWindow: 200_000},
	},
	Default: model.ModelChoice{Model: "sonnet", Effort: "high"},
}
