// Boots the real workshop-backend alongside one or more real gatekeepers under wrangler's
// createTestHarness, so tests drive production code paths end to end.
//
// Parameterised over gatekeepers on purpose: a suite for a new gatekeeper should be "point the
// harness at the package and plug in a handler module", not a forked copy of this file. Per-vendor
// suites in consumer repos use this as-is.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";
import { createTestHarness, type TestHarness } from "wrangler";
import { z } from "zod";

const HERE = dirname(fileURLToPath(import.meta.url));

// Sibling of this package, whether that's `packages/` in this repo or `public/packages/` when a repo
// vendors this one as a submodule.
const WORKSHOP_DIR = resolve(HERE, "../../workshop-backend");
const REPO_ROOT = resolve(HERE, "../../..");

/** Directory of the bundled fixture gatekeeper. See fixtures/gatekeeper-test/README-ish comments. */
export const TEST_GATEKEEPER_DIR = resolve(HERE, "../fixtures/gatekeeper-test");
export const TEST_GATEKEEPER_WORKER = "gatekeeper-test";
/** Service binding suffix, and therefore the vendor id the Workshop derives from it. */
export const TEST_GATEKEEPER_BINDING = "TEST";
export const TEST_VENDOR_ID = TEST_GATEKEEPER_BINDING.toLowerCase();

/** Username that `vars.ADMINS` grants deployment-admin rights to, mirroring run-dev-server.js. */
export const ADMIN_USERNAME = "admin";

// The slice of wrangler.jsonc the harness reads or rewrites. Loose on purpose: everything else a
// config declares flows through untouched, and wrangler re-validates the whole file when the worker
// boots -- this schema only guards the fields this file touches, so a broken config fails here with
// the field named rather than surviving a cast and failing somewhere stranger.
const WORKER_CONFIG = z.looseObject({
  name: z.string(),
  main: z.string(),
  build: z.looseObject({ command: z.string().optional(), cwd: z.string().optional() }).optional(),
  services: z.array(z.looseObject({
    binding: z.string(),
    service: z.string(),
    entrypoint: z.string().optional(),
  })).optional(),
  vars: z.record(z.string(), z.unknown()).optional(),
  worker_loaders: z.unknown().optional(),
});

/** A parsed wrangler.jsonc, typed on the fields the harness (or a `patch` callback) works with. */
export type WorkerConfig = z.infer<typeof WORKER_CONFIG>;

export type GatekeeperSpec = {
  /**
   * Service binding suffix. `GATEKEEPER_<binding>` is what the Workshop scans for, and it lowercases
   * the suffix into the vendor id -- so "JIRA" here is the vendor id "jira" in every RPC.
   */
  binding: string;
  /** The gatekeeper package's directory, holding the wrangler.jsonc to boot. */
  dir: string;
  /** Adjust the gatekeeper's config after it's read, e.g. to set vars the tests depend on. */
  patch?: (config: WorkerConfig) => void;
};

/** A real auxiliary Worker booted in the harness without binding it as a Gatekeeper vendor. */
export type AuxiliaryWorkerSpec = {
  /** Worker package or fixture directory containing wrangler.jsonc. */
  dir: string;
  /** Optional test-only configuration adjustment. */
  patch?: (config: WorkerConfig) => void;
};

// Read a checked-in wrangler.jsonc and make it usable as an *inline* harness config.
//
// A worker whose `main` is generated (capnweb-validate) needs `build.cwd` pinned to its own directory
// or the output lands in the wrong place -- run-dev-server.js pins it for the same reason. `main` then
// has to be absolute too: an inline config has no file path of its own, so wrangler resolves a
// relative `main` against the harness `root` rather than the worker directory.
function readWorkerConfig(dir: string): WorkerConfig {
  const path = join(dir, "wrangler.jsonc");
  const parsed = WORKER_CONFIG.safeParse(parse(readFileSync(path, "utf8")));
  if (!parsed.success) {
    throw new Error(`${path} is not a usable worker config: ${z.prettifyError(parsed.error)}`);
  }
  const config = parsed.data;
  config.build = { ...config.build, cwd: dir };
  config.main = join(dir, config.main);
  return config;
}

/** Build one inline Worker input whose bindings are isolated from local development variables. */
export function inlineWorker(config: WorkerConfig) {
  return {
    config: {...config, secrets: {required: []}},
    vars: config.vars ?? {},
    secrets: Object.fromEntries(
      Object.entries(config.vars ?? {}).filter((entry): entry is [string, string] =>
        typeof entry[1] === "string"),
    ),
  };
}

function workshopConfig(
    gatekeepers: { binding: string; name: string }[],
    enableWorkerLoader: boolean,
    patch?: (config: WorkerConfig) => void): WorkerConfig {
  const config = readWorkerConfig(WORKSHOP_DIR);

  // The checked-in config declares no services; run-dev-server.js adds one per gatekeeper. We add
  // only the ones the suite asked for, so buildGatekeeperVendorMap() discovers exactly those vendors
  // and the observer-config prompt has no surprise rows.
  config.services = gatekeepers.map(gk => ({
    binding: `GATEKEEPER_${gk.binding}`,
    service: gk.name,
    entrypoint: "GatekeeperVendor",
  }));

  // No CF_ACCESS_AUD, so /api takes the unauthenticated path and password signup is available.
  config.vars = { ...config.vars, ADMINS: [ADMIN_USERNAME] };

  // Most suites never execute Gadget code (a gatekeeper is in observer scope purely by having a
  // vendorId), so they do not pay the Worker Loader startup cost. Full Gadget integration tracers
  // can explicitly retain the checked-in production binding.
  if (!enableWorkerLoader) delete config.worker_loaders;

  patch?.(config);
  return config;
}

export type Harness = {
  server: TestHarness;
  /** Base URL of the running server, e.g. http://127.0.0.1:1234. */
  url: URL;
  /**
   * Dispatch a request to a named worker's own HTTP entrypoint.
   *
   * Its host is never resolved -- the request goes straight to that worker -- so no `routes` config
   * is needed. The path still has to match whatever the worker expects.
   *
   * Typed as the harness's own dispatch signature: this package sees both Node and Workers global
   * types, so spelling out Request/Response here would pick the wrong flavour.
   */
  fetchWorker(name: string, ...args: Parameters<TestHarness["fetch"]>)
      : ReturnType<TestHarness["fetch"]>;
  /**
   * Restart the Worker runtime, and return only once the reload that trails it has happened.
   *
   * Always use this rather than `server.update()` directly. A restart replaces the runtime
   * process, which severs every open WebSocket with no close frame -- the client sees the
   * transport fail, not a closed session. `server.update()` resolves on the *first* reload it
   * observes, and a second reload trails it by several seconds; unwaited, that one lands inside
   * whatever test is running by then and breaks the sessions of a test that never asked for a
   * restart. Waiting here keeps the damage inside the test that did ask.
   */
  restartRuntime(): Promise<void>;
};

// How long to give the reload that trails `server.update()`.
//
// Measured on this repo, that reload lands about 4.5s after `update()` returns; the wait usually
// ends there, and this cap only bounds the case where no reload trails at all. Tests that restart
// pay it in full, so keep it near the measured gap rather than generous: the suites that restart
// also race real scheduled callbacks.
const TRAILING_RELOAD_TIMEOUT_MS = 15_000;

/**
 * Wait for the reload that trails a restart, by holding one session open until it is severed.
 *
 * A reload replaces the runtime process, so an open session is the signal: it goes away with no
 * close frame the moment the reload happens. Resolves either way -- an expired timeout means no
 * reload trailed this restart, which is the outcome a fixed wrangler would produce.
 */
function waitForTrailingReload(url: URL): Promise<void> {
  return new Promise(resolve => {
    const wsUrl = new URL("/api", url);
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(wsUrl.toString());
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      resolve();
    };
    const timer = setTimeout(settle, TRAILING_RELOAD_TIMEOUT_MS);
    socket.addEventListener("close", settle);
    socket.addEventListener("error", settle);
  });
}

export async function startHarness(opts: {
  gatekeepers: GatekeeperSpec[];
  /** Additional Workers, such as a protocol-faithful mock upstream. */
  auxiliaryWorkers?: AuxiliaryWorkerSpec[];
  /** Retain the Workshop's checked-in Worker Loader binding. Defaults to false. */
  enableWorkerLoader?: boolean;
  patchWorkshop?: (config: WorkerConfig) => void;
  /** Defaults to this repo's root. Override when a gatekeeper lives outside it. */
  root?: string;
}): Promise<Harness> {
  // Each gatekeeper's config is read (and patched) exactly once; the service binding below points at
  // the name the booted worker will actually carry, patches included.
  const gatekeepers = opts.gatekeepers.map(gk => {
    const config = readWorkerConfig(gk.dir);
    gk.patch?.(config);
    return { binding: gk.binding, name: config.name, config };
  });
  const auxiliaryWorkers = (opts.auxiliaryWorkers ?? []).map(worker => {
    const config = readWorkerConfig(worker.dir);
    worker.patch?.(config);
    return config;
  });
  const server = createTestHarness({
    root: opts.root ?? REPO_ROOT,
    // workshop-backend is primary, so unrouted requests (e.g. /api) go to it.
    workers: [
      inlineWorker(workshopConfig(
        gatekeepers, opts.enableWorkerLoader ?? false, opts.patchWorkshop)),
      ...gatekeepers.map(({ config }) => inlineWorker(config)),
      ...auxiliaryWorkers.map(inlineWorker),
    ],
  });

  const { url } = await server.listen();
  return {
    server,
    url,
    fetchWorker: (name, ...args) => server.getWorker(name).fetch(...args),
    restartRuntime: async () => {
      await server.update(options => options);
      await waitForTrailingReload(url);
    },
  };
}

/** Boot the Workshop with only the bundled fixture gatekeeper bound. */
export function startTestGatekeeperHarness(): Promise<Harness> {
  return startHarness({
    gatekeepers: [{ binding: TEST_GATEKEEPER_BINDING, dir: TEST_GATEKEEPER_DIR }],
  });
}
