package claude

import "ai-whiteboard/internal/model"

var efforts = []string{"low", "medium", "high", "xhigh", "max"}

// Catalog is the built-in fallback list, used until a list the CLI reported is stored. It is
// never modified at runtime. Rows carry the CLI's display names and descriptions and a default
// effort ("high" when offered, else "medium", else the first level).
var Catalog = model.Catalog{
	Models: []model.CatalogModel{
		{ID: "opus", Label: "Opus 5.5", Note: "For complex work and everyday tasks", Efforts: efforts, DefaultEffort: "high", ContextWindow: 1_000_000},
		{ID: "claude-fable-5-1", Label: "Fable 5.1", Note: "For your toughest challenges", Efforts: efforts, DefaultEffort: "high"},
		{ID: "sonnet", Label: "Sonnet 5.5", Note: "Most efficient for simpler tasks", Efforts: efforts, DefaultEffort: "high", ContextWindow: 1_000_000},
		{ID: "haiku", Label: "Haiku 4.5", Note: "Fastest for quick answers", ContextWindow: 200_000},
	},
	Default: model.ModelChoice{Model: "sonnet", Effort: "high"},
}
