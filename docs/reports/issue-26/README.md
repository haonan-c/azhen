# Issue 26 evidence provenance

The historical reports in this directory refer to intermediate `.patch` files. Those source-code
snapshots were removed because they duplicated the repository and could drift from it. Use the Git
history as the canonical evidence:

| Concern | Commit |
| --- | --- |
| Site page registry | `e0bd3027f58f1e354e10ec772ffe02ff6c7891f3` |
| Router SEO boundary | `110952a829f8b790140039ad31f8ec5bc0b2e987` |
| Anonymous Angle Run | `a101f20c6c3b71266d806f2bb5a4360ee715aec6` |
| Marketing Landing Page | `f1e55f0d4825a5de1d06db62769acb00b90edd0e` |
| Hydration fix | `847bbc92ba1cf7891532437272e765a1bdab5e90` |
| Acceptance and review evidence | `b0dcd80deb27239d403a94a42e772d8f93031097` |
| RateLimit bindings | `6545455a947c659f10a711e597c7edcac41ad0c2` |
| Locale-safe Anonymous Angle Run restore | `ddf44d267cbc3bdab7c2d79c47906f27ccc2204f` |
| `x-default` locale decision | `5e329065fc8fa5788cb38f5ddb94219fd41a9c97` |

For example, use `git show <commit>` or `git diff <commit>^ <commit>` to inspect the exact change.
