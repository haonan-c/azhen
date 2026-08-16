# Angle Wall source

This directory intentionally contains no Angle Wall entry in this delivery.

Every future `<id>.json` file must come from a real `gatekeeper-ugc-ads` run and a human review. Do not add a sample, placeholder, invented result, customer claim, logo, metric, or quotation. The first release needs exactly 12 reviewed entries before the Angle Wall can appear on the Production Site.

Each file must contain these fields and no other fields:

- `id`
- `industry`
- `platform`
- `angleName`
- `tension`
- `hypothesis`
- `openingHook`
- `scriptExcerpt`
- `producedOn`

All fields are non-empty strings. `scriptExcerpt` contains 80 to 120 English words. `producedOn` uses the `YYYY-MM-DD` form so an old entry stays visible as old. The source Ad Angle and script excerpt stay in English on both locales. The field labels use the page message catalog.

The frontend loads all JSON files at build time. An invalid file stops the build instead of publishing partial or invented content. With zero valid files, the complete Angle Wall section is absent from the HTML.
