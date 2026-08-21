# Issue #44 DeepSeek pricing source

Checked on 2026-08-20 against DeepSeek's current official documentation. This repository must not
read the pricing page at runtime and must not use the `pi-ai` floating-point catalog as a financial
source of truth.

## Released catalog

The platform release catalog for Issue #44 contains these USD prices per one million tokens:

| Model | Provider version | UTC tier | Cache hit | Cache miss | Output |
| --- | --- | --- | ---: | ---: | ---: |
| `deepseek-v4-flash` | `DeepSeek-V4-Flash-0731` | off-peak | 0.007 | 0.22 | 0.66 |
| `deepseek-v4-flash` | `DeepSeek-V4-Flash-0731` | peak | 0.014 | 0.44 | 1.32 |
| `deepseek-v4-pro` | `DeepSeek-V4-Pro-0813` | off-peak | 0.022 | 0.66 | 1.98 |
| `deepseek-v4-pro` | `DeepSeek-V4-Pro-0813` | peak | 0.044 | 1.32 | 3.96 |

Peak periods are represented by the platform as the half-open UTC intervals `[01:00, 04:00)` and
`[06:00, 10:00)`. The official page names the time ranges but does not state endpoint inclusivity;
the half-open representation is the platform's deterministic boundary rule.

Reasoning tokens are an output-token detail. They use the output rate and must not be added a
second time.

## Primary sources

- Current models and prices: <https://api-docs.deepseek.com/quick_start/pricing/>
- Current model identifiers: <https://api-docs.deepseek.com/api/list-models/>
- Model and price change history: <https://api-docs.deepseek.com/updates/>

The official page is mutable. Each persisted Usage Rate version therefore copies the full released
catalog and schedule, together with its repository catalog version. A later code release only makes
a new catalog available; it does not silently change the deployment's current Usage Rate version.
