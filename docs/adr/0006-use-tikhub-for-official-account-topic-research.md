# Use TikHub for Official Account topic research

Use TikHub as the only initial data provider for cross-account WeChat Official Account topic
research. The repository already integrates TikHub and can reuse its deployment credential and
operational experience; its documented search and article-statistics APIs give better overall
integration and maintenance value despite requiring more paid calls than a single-call provider.
Keep the Agent-facing article shape provider-neutral, but do not add a fallback provider or query
cache until real usage shows that either is needed.
