# Issue #52 independent acceptance oracle

## Status and dependency

Issue #52 cannot close until Issue #50 is closed and its two-stage Gatekeeper billing contract has
passed its own tests. This oracle assumes the Issue #50 contract is available and verifies that the
production Home Assistant Gatekeeper uses it correctly for every caller-visible read operation.

The implementation must cover 42 public Session methods that currently reach Home Assistant. The
method HomeAssistantSession.getDashboard() only creates a local capability and does not currently
reach Home Assistant, so it must not create a Metering Attempt, Usage Record, or Usage Charge.

The metering boundary must be at the caller-visible read method. It must not be placed in callApi(),
callWs(), fetchRegistrySnapshot(), REST fetch, or WebSocket send. A low-level boundary would charge
one business operation several times for registry commands, pagination, polling, or transport
retries. It would also incorrectly charge the internal reads used by Issue #53 Actions.

## Repository evidence

Relevant production sources:

- packages/gatekeeper-homeassistant/src/homeassistant.ts:1982 contains the Session implementations.
- packages/gatekeeper-homeassistant/src/types.d.ts:276 contains the public Home Assistant API.
- packages/gatekeeper-homeassistant/src/homeassistant-api.ts:70 contains the REST transport.
- packages/gatekeeper-homeassistant/src/homeassistant-api.ts:230 contains the WebSocket transport.
- packages/gatekeeper-homeassistant/src/homeassistant-api.ts:439 contains fetchRegistrySnapshot().
- packages/gatekeeper-homeassistant/package.json currently has no test script.
- packages/integration-tests/src/harness.ts can boot the real Workshop and Gatekeeper Workers.
- packages/integration-tests/src/network-interceptor.ts intercepts fetch(), but does not by itself
  provide a Home Assistant WebSocket server.

fetchRegistrySnapshot() currently performs:

1. One REST GET of /api/states.
2. One Home Assistant WebSocket connection and authentication handshake.
3. Five WebSocket registry commands for areas, floors, labels, devices, and entities.

All of those internal calls are one Billable API Operation when one public Session method requested
the snapshot.

## Stable method registry and rate units

The following keys are the recommended canonical registry. An implementation may use another
equivalent naming scheme only if it fixes the complete list in checked-in constants before rates or
Usage Records exist. Existing keys must survive class, helper, URL, and transport refactors. A key
must never be derived from a runtime function name, URL, entity ID, method argument, or Home
Assistant command.

For every entry:

- rate unit: operation
- quantity: 1
- price: one fixed API rate for the caller-visible method
- not a unit: HTTP request, WebSocket command, retry, page, entity, history item, or response byte
- a missing rate creates Unpriced Use with quantity 1 and a zero Usage Charge

### Whole-instance Session

| # | Public method | Stable method key | Current upstream work |
|---:|---|---|---|
| 1 | HomeAssistantSession.getConfig | homeassistant.instance.get-config | REST config |
| 2 | HomeAssistantSession.listAreas | homeassistant.instance.list-areas | WS area registry |
| 3 | HomeAssistantSession.listFloors | homeassistant.instance.list-floors | WS floor registry |
| 4 | HomeAssistantSession.listLabels | homeassistant.instance.list-labels | WS label registry |
| 5 | HomeAssistantSession.listDevices | homeassistant.instance.list-devices | WS device registry |
| 6 | HomeAssistantSession.listEntities | homeassistant.instance.list-entities | registry snapshot |
| 7 | HomeAssistantSession.listDomains | homeassistant.instance.list-domains | REST states |
| 8 | HomeAssistantSession.listServices | homeassistant.instance.list-services | REST services |
| 9 | HomeAssistantSession.getArea | homeassistant.instance.get-area | registry snapshot |
| 10 | HomeAssistantSession.getLabel | homeassistant.instance.get-label | registry snapshot |
| 11 | HomeAssistantSession.getDevice | homeassistant.instance.get-device | registry snapshot |
| 12 | HomeAssistantSession.getEntity | homeassistant.instance.get-entity | REST entity state |
| 13 | HomeAssistantSession.renderTemplate | homeassistant.instance.render-template | REST template POST |
| 14 | HomeAssistantSession.getHistory | homeassistant.instance.get-history | REST history |
| 15 | HomeAssistantSession.getLogbook | homeassistant.instance.get-logbook | REST logbook |
| 16 | HomeAssistantSession.listDashboards | homeassistant.instance.list-dashboards | WS dashboard list |
| 17 | HomeAssistantSession.listLovelaceResources | homeassistant.instance.list-lovelace-resources | WS resources |

HomeAssistantSession.getDashboard is local-only. It creates DashboardImpl and records an existing
observation audit, but performs no upstream work. It is deliberately absent from the billing
registry.

### Area capability

| # | Public method | Stable method key | Current upstream work |
|---:|---|---|---|
| 18 | Area.describe | homeassistant.area.describe | registry snapshot |
| 19 | Area.getFloor | homeassistant.area.get-floor | registry snapshot |
| 20 | Area.listEntities | homeassistant.area.list-entities | registry snapshot |
| 21 | Area.listDevices | homeassistant.area.list-devices | registry snapshot |
| 22 | Area.getEntity | homeassistant.area.get-entity | registry snapshot |
| 23 | Area.getDevice | homeassistant.area.get-device | registry snapshot |
| 24 | Area.getHistory | homeassistant.area.get-history | snapshot and optional REST history |

### Label capability

| # | Public method | Stable method key | Current upstream work |
|---:|---|---|---|
| 25 | Label.describe | homeassistant.label.describe | registry snapshot |
| 26 | Label.listEntities | homeassistant.label.list-entities | registry snapshot |
| 27 | Label.getEntity | homeassistant.label.get-entity | registry snapshot |
| 28 | Label.getHistory | homeassistant.label.get-history | snapshot and optional REST history |

### Device capability

| # | Public method | Stable method key | Current upstream work |
|---:|---|---|---|
| 29 | Device.describe | homeassistant.device.describe | registry snapshot |
| 30 | Device.getArea | homeassistant.device.get-area | registry snapshot |
| 31 | Device.listEntities | homeassistant.device.list-entities | registry snapshot |
| 32 | Device.getEntity | homeassistant.device.get-entity | registry snapshot |
| 33 | Device.getHistory | homeassistant.device.get-history | snapshot and optional REST history |

### Entity capability

| # | Public method | Stable method key | Current upstream work |
|---:|---|---|---|
| 34 | Entity.describe | homeassistant.entity.describe | registry snapshot and overlay |
| 35 | Entity.getState | homeassistant.entity.get-state | REST state; with pending Actions also a snapshot |
| 36 | Entity.getDevice | homeassistant.entity.get-device | registry snapshot |
| 37 | Entity.getArea | homeassistant.entity.get-area | registry snapshot |
| 38 | Entity.getLabels | homeassistant.entity.get-labels | registry snapshot |
| 39 | Entity.getHistory | homeassistant.entity.get-history | REST history |
| 40 | Entity.getLogbook | homeassistant.entity.get-logbook | REST logbook |

### Dashboard capability

| # | Public method | Stable method key | Current upstream work |
|---:|---|---|---|
| 41 | Dashboard.describe | homeassistant.dashboard.describe | WS dashboard list |
| 42 | Dashboard.getConfig | homeassistant.dashboard.get-config | WS Lovelace config |

## Explicit exclusions

Issue #52 does not meter:

- HomeAssistantSession.getDashboard while it remains local-only.
- Symbol.dispose, listPendingActions, local simulation overlay computation, and resourceUrl().
- Account connection validation, HomeAssistantUserImpl.describe(), Gatekeeper resource describe(),
  and resource configurator reads. They are not public Agent or Gadget Session operations and do not
  have the required Usage Principal context.
- Reads used to construct a pending Action description.
- Reads used to capture an Action revert snapshot.
- Any write, Action application, rejection, reconciliation, or reversion.

If a formerly local Session method later begins a caller-visible upstream business read, the method
registry and its acceptance tests must be updated deliberately. Adding a low-level request must not
silently create a new charge.

## Required lifecycle

Each registry method must have this logical order:

~~~
validate ordinary method arguments
  -> begin(stable method key, trusted operation ID, Usage Principal,
           Usage Source, connected account/resource dimension)
  -> create priced reservation or zero-credit Unpriced attempt
  -> persist started
  -> perform the first possible upstream Home Assistant work
  -> perform zero or more internal calls, pages, polls, or retries with the same operation ID
  -> complete with accepted/successful, failed-before-execution, or unknown
  -> authorizeObservation
  -> return or withhold the result
~~~

Required behavior:

- If begin, reservation, or authoritative attempt persistence fails, no Home Assistant REST request,
  WebSocket connection, authentication message, or command may occur.
- started is durable before the first possible upstream work.
- All internal calls reuse one trusted operation ID.
- An executed read settles before or independently of authorizeObservation(). A later authorization
  failure must not make an already executed read free.
- Unpriced Use follows the same lifecycle with a zero amount.
- A missing rate never blocks the read solely because the rate is absent.
- A pre-execution failure releases its reservation.
- A dispatched request whose Home Assistant outcome cannot be proven remains unknown-held.
- A duplicate delivery with the same operation ID returns the prior result and has no second
  financial or projection effect.
- The Charge Snapshot is issued at begin. A later administrator rate update applies only to a later
  operation.

### Failure classification

The implementation must not classify every thrown HomeAssistantError as failed-before-execution.

- Local validation failure before begin: no attempt and no upstream call.
- Authoritative begin/reservation failure: no upstream call.
- WS connection or authentication failure before the caller-visible command is sent and before any
  other upstream part of that operation succeeded: failed-before-execution and release.
- REST request or WS command sent, followed by timeout, connection close, crash, or lost response:
  unknown-held.
- A definite Home Assistant response proves that upstream processed the request. This includes an
  HTTP error response or WS success:false after the business command was sent. It is not a
  pre-execution failure.
- A multi-call operation where one upstream part succeeded before a later part failed cannot be
  released as if no work occurred. It must use the Issue #50 accepted/unknown rules consistently.

listFloors() and listLabels() currently catch a WS command error and return an empty list. If that
product behavior remains, the successful public method return is still one executed operation.

Area.getHistory(), Label.getHistory(), and Device.getHistory() first fetch a registry snapshot. If
the scope contains no entity, they return an empty result without calling the history endpoint. They
still performed one caller-visible operation and must settle once.

## Acceptance-criteria tracer matrix

| Issue #52 acceptance criterion | Required observable evidence |
|---|---|
| Every upstream read begins before its first external request | All 42 methods have explicit keys. A forced begin failure produces zero mock HA traffic. While the first mock request is blocked, another real RPC can observe the reservation and started attempt. |
| Every method has a stable key | A checked-in snapshot test asserts the exact 42 unique strings. Keys contain no runtime URL, ID, filter, domain, argument, or transport command. |
| Pagination, polling, and retries do not add charges | listEntities executes its real multi-request registry snapshot but produces one attempt, record, operation count, and charge. Scoped history also produces one despite snapshot plus history. Same-ID redelivery produces no duplicate. |
| Priced reads settle once | A configured fixed rate deducts the exact captured amount once and retains the method key and Charge Snapshot. |
| Missing rates create visible Unpriced Use | Removing one method rate still executes the read, records quantity 1, marks Unpriced Use, charges zero, and appears in User and administrator reporting. |
| Executed reads settle when authorization withholds the result | The mock upstream completes. A rejecting ApprovalQueue then rejects the RPC result. The balance and Usage Record still show exactly one completed operation. |
| Pre-execution failure releases | The test proves that no business request was sent and that the reservation became released. |
| Uncertain outcome remains held | The mock accepts a dispatched request and drops the connection before a result. The attempt becomes unknown, the reservation remains held, and automatic duplicate execution does not occur. |
| Representative paths | Runtime tests include a catalog read, entity state, history, and dashboard config. A registry-snapshot method proves the multiple-internal-call case. |

## Usage Principal and attribution checks

Issue #52 must preserve every Issue #50 attribution guarantee:

- The Workshop host, not Gadget code, supplies the trusted Usage Principal.
- The operation cannot accept, omit, or replace its principal through method arguments.
- Direct Agent and Gadget calls keep distinct Usage Sources.
- Two collaborators using one shared App receive separate User principals.
- A connected Home Assistant account or resource is a reporting dimension, not a principal.
- A child Area, Label, Device, Entity, or Dashboard capability retains the original trusted
  metering capability, principal, source, account dimension, and operation-ID authority when its
  SessionContext is forked.
- The Home Assistant connected-account owner must not automatically become the principal when
  another collaborator initiates the operation.

The connected-account dimension must be a Workshop-issued stable opaque identifier. It must not be
the Home Assistant URL or token. A scoped binding may retain a host-owned opaque resource dimension,
but a method argument such as entityId or dashboard urlPath is not automatically a connected
resource dimension.

## Privacy oracle

Neither User nor administrator usage data may contain:

- Home Assistant LLAT or Authorization header.
- Home Assistant base URL, including private LAN addresses.
- Template text or template variables.
- Entity IDs supplied as arguments.
- Entity filters, domains, date ranges, dashboard paths, or other API arguments.
- Entity states, attributes, history, logbook entries, services, dashboard config, or response body.
- Approval observation title or description.
- Request URL, request body, response body, or error response body.
- Raw thrown error messages.

Current observation descriptions can contain entity state, filter JSON, entity IDs, area/device
names, and a template preview. Observation audit and Usage Record are independent contracts.
Metering must never copy the description into usage, ledger, outbox, projection, or logs.

The stable method key must be a constant. It must not concatenate an entity ID, filter, service
domain, dashboard path, Home Assistant command, or URL.

Privacy tests must use distinctive sentinel strings in:

- a template and variables,
- an entity ID and filter,
- state and history responses,
- dashboard path and dashboard config,
- an upstream error body,
- the fake token and mock base URL.

After the call, the tests must search all exposed Usage Records, Credit Ledger Entries, summary
facts, administrator query results, and captured server logs for those sentinels.

## Pagination, polling, and retry oracle

The operation boundary must surround the complete caller-visible method:

- listEntities uses one operation around GET states plus all registry commands.
- Entity.getState with pending Actions uses one operation around the state read and registry
  snapshot, even when those requests execute concurrently.
- Scoped getHistory uses one operation around target discovery and the history request.
- An implementation that adds pagination or polling must keep begin outside the loop.
- An implementation that adds a sanctioned transport retry must keep begin outside the retry
  helper and reuse one operation ID.
- A retry that exhausts after a request may have reached Home Assistant becomes unknown-held.

The current Home Assistant client does not implement a general automatic retry or paginated
endpoint. Issue #52 must not add speculative retry behavior merely to satisfy a test. The accepted
proof is:

1. The real multi-request methods produce one charge.
2. The Issue #50 shared contract suite proves that internal retries reuse one operation.
3. Full Worker duplicate delivery with the same trusted operation ID is idempotent.
4. If real Home Assistant retry or pagination is introduced, a direct regression test is added at
   the same time.

## Required tests

### Package-level registry and contract tests

Add:

- packages/gatekeeper-homeassistant/src/billing-methods.ts or an equivalent explicit registry.
- packages/gatekeeper-homeassistant/__tests__/billing-methods.test.ts.
- packages/gatekeeper-homeassistant/vitest.config.ts.
- a package.json test script: vitest run.
- the catalog Vitest development dependency.

The registry test must assert:

- exactly 42 read keys;
- every key is unique and equals the approved snapshot;
- all current public read methods are either in the registry or explicitly local-only;
- HomeAssistantSession.getDashboard is local-only;
- no Action/write method appears;
- every entry has operation as its rate unit and quantity 1.

A pure Node registry test is useful but is not sufficient acceptance evidence.

### Real production Worker and mock upstream suite

Add a Home Assistant metering suite under packages/integration-tests/__tests__ or an equivalent
real-workerd contract suite.

It must:

- boot the production workshop-backend Worker;
- boot the production gatekeeper-homeassistant Worker from its checked-in wrangler configuration;
- drive the Workshop over real Cap'n Web;
- use real Durable Objects and real SQLite storage;
- use the production Home Assistant account connection path;
- use only a fixed fake LLAT and a loopback mock Home Assistant URL;
- mock REST and WebSocket Home Assistant protocols;
- fail any network access outside the approved loopback mock;
- query observable balances, reservations, attempts, Usage Records, and administrator reports through
  real RPC methods;
- never use a Map mock as evidence for authoritative financial behavior.

The mock Home Assistant must implement:

- GET /api/ for connection validation;
- /api/config;
- /api/states and /api/states/:entityId;
- /api/services;
- /api/template;
- /api/history/period;
- /api/logbook;
- /api/websocket authentication;
- area, floor, label, device, and entity registry commands;
- Lovelace dashboard list, resources, and config commands.

The existing NetworkInterceptor covers Worker fetch subrequests only. Home Assistant uses a real
WebSocket. The test therefore needs a loopback server that handles both HTTP and WebSocket, or a
documented harness route that gives the production Worker a real WebSocket endpoint. A green test
that mocks only REST is not sufficient.

Required runtime cases:

1. A table-driven pass over all 42 methods verifies the expected key and one operation.
2. HomeAssistantSession.getDashboard creates no Metering Attempt.
3. listEntities produces one charge for its six current upstream calls.
4. Area.getHistory produces one charge for snapshot plus history.
5. Priced and Unpriced executions of the same representative method.
6. A blocked first request proves reservation and started exist before upstream completes.
7. A begin/reservation failure proves zero upstream traffic.
8. Upstream completion followed by authorization rejection still settles.
9. WS authentication failure before a command releases.
10. Connection loss after a command is sent creates unknown-held.
11. Same-operation-ID replay creates no duplicate request, charge, release, or projection fact.
12. Sentinel privacy checks for template, history, state, dashboard, error, URL, and fake token.
13. Agent/Gadget source and collaborator principal attribution.

Tests must use fresh User identities and operation IDs. The integration harness keeps storage for the
whole file and does not provide a cheap per-test wipe.

## Red flags that block closure

Any of the following blocks Issue #52:

- Metering is added inside callApi(), callWs(), fetchRegistrySnapshot(), REST fetch, or WS send.
- Completion happens only after authorizeObservation().
- A new operation ID is generated per internal request, page, poll, or retry.
- All thrown transport errors are classified as pre-execution.
- A request that may have reached Home Assistant is automatically released.
- A missing rate skips the Metering Attempt or Usage Record.
- Unpriced Use is not visible in User and administrator queries.
- A duplicate operation creates another charge or projection fact.
- Rate or Usage Credit arithmetic uses JavaScript number.
- A child capability loses the trusted principal or metering capability.
- A connected-account owner replaces the initiating collaborator as principal.
- Usage data stores observation descriptions, arguments, bodies, response content, URL, token, or
  raw error text.
- The HA base URL or LLAT is used as the external-account dimension.
- getDashboard is charged despite performing no upstream work.
- Action preparation or revert snapshot reads are charged as separate observations.
- A projection failure blocks or rolls back authoritative settlement.
- An authoritative begin or started failure still allows upstream work.
- Tests use a fake financial Map, a copied Gatekeeper, test-only production branches, real HA
  credentials, or uncontrolled internet access.

## Boundary with Issue #53

Issue #52 owns observation/read methods only. Issue #53 owns:

- HomeAssistantSession.callService.
- HomeAssistantSession.fireEvent.
- Area.callService.
- Label.callService.
- Device.callService.
- Entity.callService and every typed entity control.
- Dashboard.saveConfig.
- applyAction(), rejectAction(), and revertAction().
- Action approval, post-approval reservation, side-effect idempotency, unknown side effects, and
  administrator reconciliation.

Reads used for Action descriptions or revert snapshots are internal work for the one Action. They
must not receive a separate Issue #52 read charge.

This boundary is the main reason not to instrument fetchRegistrySnapshot() globally. The preferred
design is a thin runReadOperation(methodKey, callback) boundary on public read methods, implemented
with the Issue #50 coordinator.

## Quality gates and closure conditions

Issue #52 can close only when:

1. Issue #50 is closed and its two-stage contract tests pass.
2. All 42 methods have stable keys and getDashboard is explicitly local-only.
3. The real production Worker plus mock REST/WS upstream tracer passes.
4. Priced, Unpriced, authorization-withheld, pre-execution, unknown-held, idempotency, principal,
   source, external-account, and privacy behavior has observable evidence.
5. The following focused and workspace gates pass:

~~~
pnpm --filter @gadgets/homeassistant-gatekeeper test
pnpm --filter @gadgets/homeassistant-gatekeeper build
pnpm --filter @gadgets/integration-tests test
pnpm lint:check
pnpm build
pnpm test
pnpm lint
~~~

6. Because pnpm build is primarily type-check and code generation, the production release bundle
   also completes as a dry run:

~~~
node scripts/release/build-release.mjs --out <temporary-directory> --release-id issue-52-local
~~~

The dry run must not upload, promote, deploy, migrate production data, or use production secrets.

7. The lockfile contains only necessary dependency changes.
8. GitHub closure evidence identifies the test correctly as a real workerd production Worker with a
   mock Home Assistant upstream. It must not be described as validation against a real production
   Home Assistant installation.

## Review result for the current baseline

The baseline does not implement Issue #52 and has no Home Assistant package test script. The current
source also places authorizeObservation() after each upstream read. The implementation must preserve
that audit behavior while ensuring that the financial completion is already durable when later
authorization withholds the result.

This oracle was produced by read-only inspection. It does not authorize real Home Assistant
credentials, deployment, migration, or production access.
