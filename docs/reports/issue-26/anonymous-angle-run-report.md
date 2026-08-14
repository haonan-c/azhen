# Anonymous Angle Run Backend Patch Report

## 1. Scope and result

This report covers the source archive that the task identifies as repository commit `38db925` and the requirements in `brief-C.md`.

Delivered patch:

- Patch file: `anonymous-angle-run-38db925.patch`
- Patch SHA-256: `e310e4b92596c6ba280c7a8dcf8b3bc2396d52a5433c46cf4300ca362827db2e`
- Patch size: 29,361 bytes, 738 lines
- Changed files: 6
- Insertions: 680
- Runtime dependencies added: none
- RPC API changes: none

Input checksums:

- Source ZIP SHA-256: `fca73bb122e1fc9a3c1c57f6ec7937428b1cc9935cc269aaaaca25ebd008aec0`
- Task file SHA-256: `2cc968a49335fdd5b77075a07b269017e299aa3e5a460042df82b4a220449aab`

The patch adds one stateless HTTP endpoint, one backend module, one test module, two optional rate-limit bindings, and one shared contract subpath. It does not add a fake-result path. It returns `503 unavailable` when the deployment does not have the required model or rate-limit configuration.

## 2. Important task and repository differences

### 2.1 The archive does not contain Git metadata

**Verified from the archive:** The ZIP does not contain `.git` metadata. I could compare and apply the patch against the extracted source tree, but I could not independently prove that the tree is commit `38db925`.

**Decision:** I used the complete extracted tree as the patch baseline that the task identifies as commit `38db925`.

### 2.2 `scripts/generate-wrangler-prod.js` is not in the archive

**Verified from the repository:** The task refers to `scripts/generate-wrangler-prod.js`, but that file does not exist in the supplied tree. The repository contains `scripts/release/manifest-lib.mjs`. That file says that it is the open-source analog of the internal production generator.

`manifest-lib.mjs` has a closed set of supported Wrangler keys. It rejects an unknown key. It does not support `ratelimits` at this baseline.

**Decision:** The patch does not add `ratelimits` to the checked-in base `wrangler.jsonc`. Such a change would make the release-manifest generator fail until the generator, deploy renderer, and golden file change together.

### 2.3 The quick-model path needs an initiator

**Verified from the repository:** `AiGatewayConfig.getQuickModelConfig()` returns only an `AiModelConfig`. `getModel()` also requires an `AiChatAuthorInfo`. The common AI Gateway metadata builder always writes `initiator.id` to the `user` metadata field. The repository has no anonymous initiator type and no anonymous model-call precedent.

The existing quick-model precedent is title creation inside an authenticated Durable Object. It receives a real initiator. It also has a cost-tracking TODO. It is not an anonymous precedent.

**Decision:** The endpoint uses one fixed deployment-workload identity:

```ts
{
  type: "agent",
  id: "anonymous-angle-run",
  name: "Anonymous Angle Run",
}
```

This value is not derived from the visitor. The handler does not use it to open a User Durable Object. It only satisfies the existing model-routing and Gateway-metadata contract. The value identifies a deployment workload, not a Gadgets user.

### 2.4 Model selection and billing are not controlled by the model ID alone

**Verified from the repository:** `getModel()` has three routing modes:

1. A connected user's Gateway, when `options.userGateway` is present.
2. The deployment's Gateway, when `CF_AI_GATEWAY` is configured.
3. Direct provider access, when neither Gateway route applies.

The quick model ID does not select the billing path by itself.

**Decision:** The endpoint first requires a valid deployment `AiGatewayConfig`. It then calls `getModel()` without `userGateway`. Therefore, it cannot use a visitor's or another user's BYOK credentials. When Gateway configuration is absent or invalid, it returns `503` before rate limiting and before model completion.

### 2.5 `CF_AI_GATEWAY_WAI_DIRECT` is a routing exception inside Gateway mode

**Verified from the repository:** When `CF_AI_GATEWAY_WAI_DIRECT === "true"`, `AiGatewayConfig` is still enabled, but Workers AI uses the plain account REST endpoint. The code comment states that this route has no named Gateway, no Gateway metadata, and no Gateway log route. It still uses the deployment account ID and API token.

This is a material qualification to the task statement that deployment-funded calls only exist “in AI Gateway mode.” The deployment configuration is Gateway mode, but the actual Workers AI request can bypass the named Gateway.

**Decision:** The patch preserves the repository's existing routing rules. It does not add a fourth billing path. Operators that require named-Gateway logging and cost records must not set `CF_AI_GATEWAY_WAI_DIRECT=true` for this deployment.

### 2.6 AI Gateway payload logs can conflict with a broad “no persistence” reading

**Verified from current official Cloudflare documentation:** AI Gateway logs can store request and response payloads, and payload logging is enabled by default unless the operator changes the Gateway setting or request headers. The repository model layer does not expose a per-call payload-log switch through `completeText()`.

**Verified from this patch:** The endpoint does not write its input or result to KV, R2, Durable Objects, Pipelines, analytics, or application logs.

**Important limit:** This patch guarantees no application-storage persistence. It does not, by itself, guarantee end-to-end zero retention by AI Gateway or the model service.

**Required deployment action:** Disable AI Gateway request/response payload logging for the Gateway used by this endpoint, or set a deployment-wide policy that gives the same result. Metadata-only logging can remain enabled when appropriate. This action is outside this focused patch because changing the common model transport would affect all model calls.

### 2.7 The landing documents conflict with the endpoint red line

**Verified from the repository:** The task requires an Ad Angle-only endpoint. The older landing PRD still contains a `Create this video` action and several finished-media promises. The newer design document removes finished-media delivery but still promises a ready-to-shoot script in Hero copy. The anonymous boundary in the PRD says that an anonymous visitor cannot receive a full script or video.

**Decision:** The endpoint follows the task contract and the anonymous boundary. It returns only three Ad Angles with the five fixed fields. It does not return a script, storyboard, media asset, or public URL.

### 2.8 The full first-phase anti-abuse design cannot fit this fixed request contract

**Verified from the repository:** The landing PRD asks for IP, device fingerprint, frequency controls, and conditional CAPTCHA. It also asks for one lifetime batch and a temporary session. The task fixes a request body with only `product`, `market`, and `locale`; it forbids new authentication, persistence, and frontend work; and it requires a stateless endpoint.

**Decision:** This patch implements the strongest mechanism that fits these boundaries:

- one actor rate limit, keyed by a verified Access identity or the connecting IP;
- one deployment-budget rate limit, keyed by a fixed endpoint key;
- fail closed when either binding is absent or fails;
- bounded input, bounded model output, bounded model tokens, and a timeout.

This is not a lifetime-one-run guarantee. Device identity, CAPTCHA, and lifetime enforcement need a later contract and state design.

### 2.9 The workerd assertion file is at repository root

**Verified from the repository:** The task names `packages/workshop-backend/test-setup/assert-workerd.ts`. The actual file is `test-setup/assert-workerd.ts`, and `packages/workshop-backend/vitest.config.ts` refers to it with `../../test-setup/assert-workerd.ts`.

## 3. Files reviewed

I fully reviewed the required files and the directly related configuration files:

- `packages/workshop-backend/src/client-errors.ts`
- `packages/workshop-backend/__tests__/client-errors.test.ts`
- the `fetch()` routing section in `packages/workshop-backend/src/server.ts`
- `packages/workshop-backend/src/ai-gateway.ts`
- `getModel()`, `ModelHandle`, metadata, and routing in `packages/workshop-backend/src/ai-models.ts`
- `packages/workshop-backend/src/ai-invoke.ts`
- `packages/workshop-backend/src/access.ts`
- `packages/workshop-backend/src/env.d.ts`
- `packages/workshop-backend/src/streaming-json-parser.ts`
- `packages/workshop-backend/src/observability.ts`
- `packages/backend-utils/src/logger.ts` and its logger core
- `packages/workshop-backend/vitest.config.ts`
- `test-setup/assert-workerd.ts`
- `CONTEXT.md`
- `AGENTS.md`
- `docs/prd/ugcangle-landing-design.md`, including sections 3.3 and 4.1
- `docs/prd/ugcangle-landing-prd.md`, including sections 4.1 and 4.2
- `packages/workshop-shared/package.json` and existing shared subpaths
- `pnpm-workspace.yaml`
- `packages/workshop-backend/package.json`
- `packages/workshop-backend/wrangler.jsonc`
- `scripts/release/manifest-lib.mjs`
- `scripts/release-manifest.test.js`
- `scripts/testdata/golden-manifest.json`

### Why `streaming-json-parser.ts` is not used

**Verified from the repository:** That parser is an incremental parser for streamed tool-call JSON with a selected streaming string field. This endpoint uses a one-shot text completion and needs to accept direct JSON, fenced JSON, or a bounded JSON object inside extra text.

**Decision:** A small local parser is clearer and safer than adapting the specialized streaming parser. The local parser still validates the complete response after parsing and rejects partial data.

## 4. Patch contents

| File | Change |
| --- | --- |
| `packages/workshop-backend/src/anonymous-angle-run.ts` | New 300-line endpoint module with validation, two limits, Access handling, model call, timeout, parsing, and JSON responses. |
| `packages/workshop-backend/__tests__/anonymous-angle-run.test.ts` | New 313-line workerd-style test module for all required observable response classes. |
| `packages/workshop-backend/src/server.ts` | One import and one exact-path route. |
| `packages/workshop-backend/src/env.d.ts` | Two optional `RateLimit` bindings with fail-closed behavior in the comment. |
| `packages/workshop-shared/src/anonymous-angle-run.ts` | New 54-line shared request, response, limits, and error-code contract. Every exported member has a doc comment. |
| `packages/workshop-shared/package.json` | New `./anonymous-angle-run` subpath export. |

## 5. Design decisions

### 5.1 Shared contract location

**Decision:** Use a new subpath in `@gadgets/workshop-shared`.

Reasons:

- The frontend and backend need one source of truth.
- The package already exposes independent non-RPC subpaths such as feature flags, limits, theme, and external-message gateway.
- The change does not touch `src/api.ts` or the Cap'n Web RPC contract.
- A new package would add package, workspace, and dependency surface for a 54-line contract.
- Two private copies would create contract drift.

The successful response uses a tuple type, so TypeScript expresses “exactly three” at the shared boundary.

### 5.2 Request validation and body limit

The endpoint requires:

- `POST`;
- exact same-origin `Origin`;
- `application/json`, with an optional media-type parameter;
- a body of at most 16 KiB;
- `product` with 1 to 600 Unicode code points after trim;
- `market` with 1 to 300 Unicode code points after trim;
- `locale` equal to `en` or `zh`.

The 16 KiB byte limit is intentionally larger than the character limits. Valid maximum values can expand in UTF-8 or JSON escapes. The reader checks both `Content-Length` and the actual stream length.

The reader uses unique symbols for internal results. A valid JSON string such as `"too-large"` cannot collide with an internal sentinel.

### 5.3 Rate limiting

The endpoint requires both bindings:

- `ANONYMOUS_ANGLE_RUN_RATE_LIMITER`: per actor;
- `ANONYMOUS_ANGLE_RUN_BUDGET_LIMITER`: deployment cost guard.

Behavior:

- Missing binding: `503 unavailable`.
- Binding call throws: `503 unavailable`.
- Either binding returns `success: false`: `429 rate_limited`.
- Model completion does not start unless both calls succeed.

This deliberately differs from `client-errors.ts`. Browser telemetry is optional and must not affect the user, so it degrades to `204`. Anonymous inference spends deployment resources, so it fails closed.

Cloudflare Access mode uses a verified Access subject, or a hash-derived key from a verified email claim. Public mode uses `cf-connecting-ip`. An IP is not an ideal user identifier, but the fixed anonymous contract provides no stable account or device identifier.

The second limiter uses one fixed key, `anonymous-angle-run`. It acts as a deployment-wide cost guard within the locality and consistency limits of the Cloudflare Rate Limiting API.

### 5.4 Cloudflare Access mode

**Decision:** Keep the endpoint active and verify the Access JWT.

Reasons:

- A private deployment can still use the landing tool for authenticated organization members.
- A verified Access identity is more stable than a shared egress IP.
- This reuses `verifyCfAccessJwt()` and `accessRateLimitKey()` from the existing non-RPC endpoint pattern.

An invalid assertion or an assertion without a usable identity returns `403 forbidden` before rate limiting or model completion.

### 5.5 Model selection and billing path

The endpoint obtains the existing quick-model config from `AiGatewayConfig.getQuickModelConfig()`. At this baseline, it resolves to:

```text
@cf/meta/llama-3.3-70b-instruct-fp8-fast
```

The handler does not import or copy the private model constant. It uses the existing method, so model policy remains in one place.

The endpoint does not pass `userGateway`. It does not read a user, model record, capability, or Durable Object. A valid deployment Gateway configuration is a precondition. This prevents a fall-through to direct BYOK configuration when Gateway mode is absent.

The fixed workload initiator is necessary because the common model layer requires an initiator and always creates Gateway attribution metadata. No visitor value enters that identity.

### 5.6 Prompt, output, and semantic boundary

The system prompt states that the output is an Ad Angle. It requires exactly three items and the five contract fields. It explicitly rejects a finished media result, a script, a prompt, or a standalone Hook as the Ad Angle.

Visitor values are placed in JSON in the user prompt. The system prompt states that they are untrusted data and that instructions inside them must be ignored.

The parser accepts three bounded forms:

1. direct JSON;
2. JSON inside a Markdown code fence;
3. the first complete-looking object between the first `{` and last `}` when the model adds surrounding text.

Every candidate must parse and pass a complete structural check. The result must contain exactly three items. Every item must have five non-empty string fields. The handler rebuilds each result object, so extra model fields are not returned.

Internal output limits are 80 Unicode code points for `name` and 320 for each other field. Invalid, incomplete, oversized, or differently shaped output returns `503 unavailable`. No raw model output enters the response or application log.

### 5.7 Timeout and token limit

- Model timeout: 60,000 ms through `AbortSignal.timeout()`.
- Maximum completion tokens: 1,200.

`completeText()` already converts provider error or aborted final-message states into exceptions. The endpoint maps all of them to `503 unavailable`.

### 5.8 State, SSRF, analytics, and logs

The endpoint module:

- has no `fetch()` call;
- does not parse or open a visitor URL;
- does not accept `ExecutionContext`;
- does not use `ctx.exports`;
- does not read or write KV, R2, Durable Objects, Pipelines, or analytics;
- does not create a session or public URL;
- does not log visitor input, prompts, headers, tokens, raw model output, or provider error text.

Warnings use the required structured logger component and event names. Model and limiter warnings use sanitized errors.

The JSON response has `Cache-Control: no-store` for both success and failure.

## 6. Test module coverage

The new module contains observable-response tests for:

1. non-POST requests: `405`, JSON error, and `Allow: POST`;
2. cross-origin requests: `403 forbidden`;
3. non-JSON media type: `415 unsupported_media_type`;
4. oversized body: `413 payload_too_large`;
5. bad JSON, scalar JSON, missing field, wrong type, empty string, overlong strings, and bad locale: `400 invalid_request`;
6. actor or budget limit exhausted: `429 rate_limited`;
7. either limiter binding missing: `503 unavailable`;
8. Gateway disabled, incomplete, or internally conflicting: `503`, with no completion call;
9. valid model JSON: `200`, exact three-item response, expected model config, normalized input, and both limiter keys;
10. fenced JSON with surrounding text: `200`;
11. garbage, two items, four items, missing output field, and thrown completion: `503`, with no raw output in the response;
12. valid and invalid Cloudflare Access behavior;
13. no access to the repository's KV, R2, avatar, or analytics bindings.

Durable Objects in this repository are reached through `ctx.exports`, not through `Cloudflare.Env`. The endpoint handler does not accept `ExecutionContext`, and the server route does not access `ctx.exports` before it calls the handler. This is the direct architectural reason that the endpoint cannot access a Durable Object. The test uses throwing getters for the actual persistence and analytics bindings that exist on `env`.

These tests were authored but not run in this environment.

## 7. Wrangler and release actions

### 7.1 Base `packages/workshop-backend/wrangler.jsonc`

**Patch action:** No change.

Reasons:

- Local and unconfigured deployments must return `503` by design.
- A checked-in binding would make generated `Cloudflare.Env` members required and would conflict with the intentional optional declarations for self-hosted deployments.
- `manifest-lib.mjs` rejects the unknown `ratelimits` key at this baseline.

### 7.2 Suggested deployment-specific Wrangler configuration

The exact policy values need an operator decision. This is a safe starting example, not a lifetime-one-run guarantee:

```jsonc
"ratelimits": [
  {
    "name": "ANONYMOUS_ANGLE_RUN_RATE_LIMITER",
    "namespace_id": "<unique-positive-integer-string>",
    "simple": {
      "limit": 1,
      "period": 60
    }
  },
  {
    "name": "ANONYMOUS_ANGLE_RUN_BUDGET_LIMITER",
    "namespace_id": "<different-unique-positive-integer-string>",
    "simple": {
      "limit": 30,
      "period": 60
    }
  }
]
```

Use different namespace IDs unless shared counters are intentional. Cloudflare supports periods of 10 or 60 seconds for this binding.

A value of one actor call per minute is strict. It also means that a transient model failure consumes the window. An operator can use two per minute when one retry is required. This does not change the endpoint code.

### 7.3 Internal production generator

The supplied tree does not contain the internal `generate-wrangler-prod.js`. The owner of that deployment path must inject both bindings and provision two namespace IDs.

### 7.4 Open-source release manifest

If customer release manifests must enable this endpoint, local work is required in all of these parts:

1. Add `ratelimits` to `HANDLED_CONFIG_KEYS` in `scripts/release/manifest-lib.mjs`.
2. Convert each entry to the Workers script-upload binding form, with `type: "ratelimit"`, `name`, `namespace_id`, and `simple`.
3. Define how the deploy service provisions or maps account-specific namespace IDs.
4. Extend the closed placeholder and renderer contract if namespace placeholders are added.
5. Increase `manifestVersion` if the deploy contract is not backward-compatible.
6. Regenerate and review `scripts/testdata/golden-manifest.json` with the repository's documented `UPDATE_GOLDEN=1` process.

The present patch intentionally does not make this cross-system release-contract change.

### 7.5 AI Gateway privacy setting

Before production enablement, disable request and response payload storage for the Gateway used by Anonymous Angle Run. The application logger already excludes the payload, but current AI Gateway defaults can store it unless the operator changes this setting.

## 8. Attack surface and mitigation

| Attack surface | Patch mitigation | Residual limit |
| --- | --- | --- |
| Cost amplification | Actor limit, deployment-budget limit, both fail closed, 1,200 output-token cap, 60-second timeout, no model call without valid deployment Gateway configuration. | Rate Limiting is per Cloudflare location and eventually consistent. A distributed actor can exceed a nominal global budget. Use WAF/Bot controls and Gateway spend controls for stronger protection. |
| Rate-limit identity evasion | Verified Access identity in private mode; connecting IP in public mode; fixed deployment-budget key as a second control. | IP rotation and shared NATs cause false negatives and false positives. The contract has no device token or account identity. |
| Prompt injection | System instruction marks visitor values as data; values are JSON-encoded; strict output schema; exact item count; field limits; extra fields removed. | A model can still follow hostile text semantically. Structural validation cannot prove that an Ad Angle is useful or policy-compliant. |
| SSRF | No network fetch exists in the module. A pasted URL is only model text. | The model service receives the URL text. It is not opened by this Worker. |
| PII and confidential text | Input is not written to application logs or storage; provider errors and raw output are not returned or logged; response is `no-store`. | Visitor text is sent to the deployment model service. AI Gateway can store payloads by default. Disable payload logging and publish an accurate privacy notice. |
| Cross-origin browser abuse | Exact same-origin `Origin` check; no CORS enablement. | A non-browser script can forge `Origin`. Same-origin checks are not authentication. Rate limits and edge security remain necessary. |
| Cloudflare Access abuse | JWT verification and privacy-preserving stable limiter key; invalid or identity-free claims fail before the model call. | Access configuration and issuer availability are external dependencies. |
| Malformed or large input | Streaming byte limit plus field and Unicode-code-point limits; strict JSON and locale checks. | The body limit does not validate business truth or prohibited content. |
| Malformed model output | Bounded model tokens, exact schema, exact three-item count, field limits, full rejection on any defect, no raw output exposure. | Frontend code must still render returned strings as text, not trusted HTML. |
| Persistence and user-data access | Handler has no context, storage, user, capability, analytics, or URL-fetch path. | Gateway/provider operational logs are outside application storage and require deployment policy. |

## 9. Version and documentation basis

### Repository versions

Verified from `pnpm-workspace.yaml` and `packages/workshop-backend/package.json`:

- TypeScript: `7.0.2`
- Wrangler: `^4.119.0`
- Vitest: `^4.1.10`
- `@cloudflare/vitest-pool-workers`: `^0.20.2`
- `@earendil-works/pi-ai`: `0.83.0`
- `@earendil-works/pi-agent-core`: `0.83.0`
- Workers compatibility date: `2026-02-02`

### Official documentation checked on 2026-08-14

- Cloudflare Workers Rate Limiting documentation, last updated 2026-04-23:
  - requires Wrangler 4.36.0 or later;
  - exposes `limit({ key })` and `{ success }`;
  - uses `ratelimits` configuration;
  - requires a positive integer string namespace ID;
  - supports 10- or 60-second periods;
  - counters are per Cloudflare location, permissive, and eventually consistent;
  - the API is not an accurate accounting system.
- Cloudflare Workers Vitest integration documentation, last updated 2026-07-27:
  - the custom pool runs tests in the Workers runtime;
  - it supports runtime APIs and bindings;
  - it runs locally with Miniflare.
- Cloudflare Workers AI and AI Gateway documentation, including the Workers AI provider route and authenticated Gateway behavior.
- Cloudflare Workers AI model catalog for `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, which still lists the model as available and gives a 24,000-token context window.
- Cloudflare AI Gateway Logging documentation, last updated 2026-06-15:
  - request and response payload logging is enabled by default;
  - operators can disable all logs or payload storage only.
- The official pi AI README for cancellation and aborted final-message behavior.

The implementation follows the repository's pinned package API and existing source code. Current external documents were used to qualify platform behavior, not to replace repository types.

## 10. What I verified

I performed only source and patch checks that do not require dependencies:

- Read the task and all required source files.
- Compared the implementation with the existing non-RPC endpoint, model, Access, logger, test, and release patterns.
- Confirmed the patch changes only the six listed files.
- Confirmed no runtime dependency or lockfile change.
- Confirmed no RPC interface change.
- Confirmed the new endpoint module has no `fetch`, persistence, analytics, `ctx.exports`, or `waitUntil` path.
- Confirmed added lines do not add the prohibited finished-media promise phrases that were checked.
- Ran `git diff --check`; it reported no whitespace error.
- Created a fresh copy from the extracted baseline and ran `git apply --check` against the delivered patch; it succeeded.
- Applied the patch to that fresh copy; it succeeded.
- Compared all six applied files byte-for-byte with the authored files; they matched.
- Parsed the changed package JSON as JSON.

## 11. What I did not verify

I did not install dependencies. I did not run `pnpm`, npm, yarn, a build, TypeScript, lint, Vitest, workerd, Wrangler, or any other build or test command.

Therefore, I did not verify:

- TypeScript compilation under TypeScript 7.0.2;
- oxlint results;
- actual test execution in the Workers Vitest pool;
- real RateLimit binding behavior in a Cloudflare deployment;
- a real AI Gateway or Workers AI response;
- model response quality in English or Chinese;
- deployment renderer support for rate-limit bindings;
- release-manifest golden output after a future `ratelimits` change;
- production Gateway payload-log settings;
- the archive's Git commit identity.

I reasoned about these areas from the supplied source, pinned versions, existing repository patterns, and current official documentation. The local owner must run the acceptance commands from the task after applying the patch.

## 12. Final assessment

The patch is small at the architecture boundary: one endpoint module, one test module, four small integration edits, and one shared contract file. It reuses the existing non-RPC HTTP, Access, model, completion, and logger paths. It does not create an anonymous user, capability, credential, storage record, public URL, or fake Ad Angle.

The main operational work that remains is not endpoint code. It is deployment configuration:

- provision both RateLimit bindings;
- update the internal production generator or the open-source manifest/deploy contract as applicable;
- review the policy values;
- disable AI Gateway payload storage for this anonymous workload;
- run the repository acceptance commands and review any generated golden diff.
