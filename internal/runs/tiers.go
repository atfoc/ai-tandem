package runs

import (
	"fmt"
	"slices"
	"strings"

	"ai-whiteboard/internal/defaults"
	"ai-whiteboard/internal/model"
)

// The effort each tier asks for; a model that lacks it runs on its own default.
var svcTierWant = map[model.Tier]string{model.TierDeep: "high", model.TierStandard: "medium", model.TierLight: "medium"}

// svcDefaultTiers builds the tier map of kind a. base is the new-chat choice of the run's group
// (defaults.Resolve), used where the catalogue names no better model: Claude runs deep and standard
// on its first opus model and light on its first sonnet model; every other kind runs all three on
// base's model, and they differ only in effort. The catalogue has no price or size, so no cheaper
// model can be picked for light there.
func svcDefaultTiers(a model.AgentKind, cat *model.Catalog, base model.ModelChoice) model.RunTiers {
	pick := func(family string) string {
		if a == model.Claude && cat != nil {
			for _, cm := range cat.Models {
				if strings.Contains(cm.ID, family) {
					return cm.ID
				}
			}
		}
		return base.Model
	}
	choice := func(tier model.Tier, id string) model.ModelChoice {
		var cm *model.CatalogModel
		if cat != nil && id != "" {
			cm, _ = svcModel(cat, id)
		}
		return model.ModelChoice{Model: id, Effort: svcTierEffort(cm, svcTierWant[tier])}
	}
	opus := pick("opus")
	return model.RunTiers{Deep: choice(model.TierDeep, opus), Standard: choice(model.TierStandard, opus),
		Light: choice(model.TierLight, pick("sonnet"))}
}

// svcTierEffort is the effort a tier gets on model cm: want when cm offers it, else cm.DefaultEffort
// when cm offers that, else "". A model that is not known (nil) has no effort.
func svcTierEffort(cm *model.CatalogModel, want string) string {
	switch {
	case cm == nil:
		return ""
	case slices.Contains(cm.Efforts, want):
		return want
	case slices.Contains(cm.Efforts, cm.DefaultEffort):
		return cm.DefaultEffort
	}
	return ""
}

// svcCheckTiers validates and normalises a tier map against cat: ErrNoModel for a tier with no
// model, an error that names the tier for a model the catalogue does not have, and an effort the
// model lacks becomes its default. A nil catalogue accepts every model and effort as it is.
func svcCheckTiers(cat *model.Catalog, t model.RunTiers) (model.RunTiers, error) {
	for _, tier := range model.Tiers {
		c := svcTierOf(&t, tier)
		if c.Model == "" {
			return t, ErrNoModel
		}
		cm, err := svcModel(cat, c.Model)
		if err != nil {
			return t, fmt.Errorf("%w (tier %s)", err, tier)
		}
		if cm != nil {
			c.Effort = svcTierEffort(cm, c.Effort)
		}
	}
	return t, nil
}

// svcTierOf is the place of tier in t.
func svcTierOf(t *model.RunTiers, tier model.Tier) *model.ModelChoice {
	switch tier {
	case model.TierDeep:
		return &t.Deep
	case model.TierLight:
		return &t.Light
	}
	return &t.Standard
}

// svcBaseTiers is svcDefaultTiers for a run of kind a in group on the side on, with that side's
// catalogue and the group's new-chat choice for that server as they are now (defaults.Resolve with
// the side's key): the base of a draft on another server is that server's, never an empty one.
func (s *Service) svcBaseTiers(on svcSide, group string, a model.AgentKind) model.RunTiers {
	cat := s.svcCatalogOn(on, a)
	var mc model.ModelChoice
	s.Store.Read(func(st *model.State) {
		_, mc = defaults.Resolve(st.Defaults, group, on.key(), a, on.defaultCwd(s), cat)
	})
	return svcDefaultTiers(a, cat, mc)
}

// svcNewTiers is the tier map a run of kind a in group begins with on the side on: that of the run
// started last there (rd) when it was of the same kind and its models still exist in the side's
// catalogue, else the defaults.
func (s *Service) svcNewTiers(on svcSide, group string, a model.AgentKind, rd *model.RunDefaults) model.RunTiers {
	if rd != nil && rd.Agent == a && rd.Tiers != nil {
		if t, err := svcCheckTiers(s.svcCatalogOn(on, a), *rd.Tiers); err == nil {
			return t
		}
	}
	return s.svcBaseTiers(on, group, a)
}

// apply puts the tiers that are set into t, checked against cat. A new model keeps the tier's
// effort only when it has it, else takes its default; an empty effort changes nothing.
func (p TiersPatch) apply(cat *model.Catalog, t *model.RunTiers) error {
	next := *t
	set := map[model.Tier]*TierPatch{model.TierDeep: p.Deep, model.TierStandard: p.Standard, model.TierLight: p.Light}
	for _, tier := range model.Tiers {
		tp := set[tier]
		if tp == nil {
			continue
		}
		c := svcTierOf(&next, tier)
		if tp.Model != nil {
			if *tp.Model == "" {
				return errSvcEmptyModel
			}
			cm, err := svcModel(cat, *tp.Model)
			if err != nil {
				return err
			}
			c.Model = *tp.Model
			if cm != nil && !slices.Contains(cm.Efforts, c.Effort) {
				c.Effort = ""
				if len(cm.Efforts) > 0 {
					c.Effort = cm.DefaultEffort
				}
			}
		}
		if tp.Effort != nil && *tp.Effort != "" {
			cm, err := svcModel(cat, c.Model)
			if err != nil {
				return err
			}
			if cm != nil && !slices.Contains(cm.Efforts, *tp.Effort) {
				return fmt.Errorf("%s has no effort %q", c.Model, *tp.Effort)
			}
			c.Effort = *tp.Effort
		}
	}
	*t = next
	return nil
}
