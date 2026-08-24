type BrowserScenario = "success" | "ambiguous";

type CdpRequest = {
  id: number;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
};

const EMPTY_RESULT_METHODS = new Set([
  "Target.setDiscoverTargets",
  "Target.setAutoAttach",
  "Runtime.runIfWaitingForDebugger",
  "Network.enable",
  "Network.setCacheDisabled",
  "Fetch.disable",
  "Page.enable",
  "Page.setLifecycleEventsEnabled",
  "Runtime.enable",
  "Performance.enable",
  "Log.enable",
  "Emulation.setDeviceMetricsOverride",
  "Emulation.setTouchEmulationEnabled",
  "Emulation.setScriptExecutionDisabled",
  "Fetch.enable",
  "Page.bringToFront",
  "Browser.close",
]);

const EXPECTED_HTML = "<main>private-rendered-html</main>";
const EXPECTED_CDP_METHODS = [
  "Browser.getVersion",
  "Target.getBrowserContexts",
  "Target.setDiscoverTargets",
  "Target.setAutoAttach",
  "Target.createTarget",
  "Target.setAutoAttach",
  "Runtime.runIfWaitingForDebugger",
  "Network.enable",
  "Network.setCacheDisabled",
  "Fetch.disable",
  "Page.enable",
  "Page.getFrameTree",
  "Page.setLifecycleEventsEnabled",
  "Runtime.enable",
  "Performance.enable",
  "Log.enable",
  "Page.addScriptToEvaluateOnNewDocument",
  "Page.createIsolatedWorld",
  "Emulation.setDeviceMetricsOverride",
  "Emulation.setTouchEmulationEnabled",
  "Emulation.setDeviceMetricsOverride",
  "Emulation.setTouchEmulationEnabled",
  "Emulation.setScriptExecutionDisabled",
  "Network.setCacheDisabled",
  "Fetch.enable",
  "Runtime.callFunctionOn",
  "Page.bringToFront",
  "Page.captureScreenshot",
  "Browser.close",
] as const;

const EXPECTED_CDP_IDS = [
  1, 2, 3, 4, 5,
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,
  6,
] as const;

let scenario: BrowserScenario = "success";
let operations: string[] = [];
let nextCdpCommand = 0;
let nextSession = 1;
let activeSessionId: string | undefined;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    entries.sort(([left], [right]) => left.localeCompare(right));
    return Object.fromEntries(entries.map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

function assertExact(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(canonical(actual)) !== JSON.stringify(canonical(expected))) {
    throw new Error(`Invalid Browser CDP ${label}.`);
  }
}

function assertCdpRequest(request: CdpRequest): void {
  const expectedMethod = EXPECTED_CDP_METHODS[nextCdpCommand];
  if (request.method !== expectedMethod || request.id !== EXPECTED_CDP_IDS[nextCdpCommand]) {
    throw new Error(
      `Unexpected Browser CDP command ${request.method}; expected ${expectedMethod ?? "none"}.`,
    );
  }
  const expectsPageSession = nextCdpCommand >= 5 && nextCdpCommand <= 27;
  if (request.sessionId !== (expectsPageSession ? "page-session" : undefined)) {
    throw new Error(`Invalid Browser CDP session for ${request.method}.`);
  }

  switch (request.method) {
    case "Target.setDiscoverTargets":
      assertExact(request.params, {discover: true, filter: [{}]}, request.method);
      break;
    case "Target.setAutoAttach":
      assertExact(request.params, expectsPageSession ? {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
        filter: [{}],
      } : {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
        filter: [{type: "page", exclude: true}, {}],
      }, request.method);
      break;
    case "Target.createTarget":
      assertExact(request.params, {url: "about:blank"}, request.method);
      break;
    case "Network.setCacheDisabled":
      assertExact(request.params, {cacheDisabled: false}, request.method);
      break;
    case "Page.setLifecycleEventsEnabled":
      assertExact(request.params, {enabled: true}, request.method);
      break;
    case "Page.addScriptToEvaluateOnNewDocument":
      assertExact(request.params, {
        source: "//# sourceURL=pptr:internal",
        worldName: "__puppeteer_utility_world__1.3.0",
      }, request.method);
      break;
    case "Page.createIsolatedWorld":
      assertExact(request.params, {
        frameId: "main-frame",
        worldName: "__puppeteer_utility_world__1.3.0",
        grantUniveralAccess: true,
      }, request.method);
      break;
    case "Emulation.setDeviceMetricsOverride":
      assertExact(request.params, {
        mobile: false,
        width: 800,
        height: 600,
        deviceScaleFactor: 1,
        screenOrientation: {angle: 0, type: "portraitPrimary"},
      }, request.method);
      break;
    case "Emulation.setTouchEmulationEnabled":
      assertExact(request.params, {enabled: false}, request.method);
      break;
    case "Emulation.setScriptExecutionDisabled":
      assertExact(request.params, {value: true}, request.method);
      break;
    case "Fetch.enable":
      assertExact(request.params, {
        handleAuthRequests: true,
        patterns: [{urlPattern: "*"}],
      }, request.method);
      break;
    case "Runtime.callFunctionOn": {
      const {functionDeclaration, ...stableParams} = request.params ?? {};
      assertExact(stableParams, {
        arguments: [{value: EXPECTED_HTML}],
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
        executionContextId: 1,
      }, request.method);
      if (typeof functionDeclaration !== "string" ||
          !functionDeclaration.includes("document.open();") ||
          !functionDeclaration.includes("document.write(html);") ||
          !functionDeclaration.includes("document.close();")) {
        throw new Error("Invalid Browser CDP page-content function.");
      }
      break;
    }
    case "Page.captureScreenshot":
      assertExact(request.params, {
        format: "png",
        clip: {x: 0, y: 0, width: 800, height: 600, scale: 1},
        captureBeyondViewport: true,
      }, request.method);
      break;
    default:
      if (request.params !== undefined) {
        throw new Error(`Unexpected Browser CDP parameters for ${request.method}.`);
      }
  }
  nextCdpCommand++;
}

function json(value: unknown): Response {
  return Response.json(value, {headers: {"cache-control": "no-store"}});
}

function cdpResult(request: CdpRequest): Record<string, unknown> {
  switch (request.method) {
    case "Browser.getVersion":
      return {
        protocolVersion: "1.3",
        product: "Chrome/fixture",
        revision: "fixture",
        userAgent: "fixture",
        jsVersion: "fixture",
      };
    case "Target.getBrowserContexts":
      return {browserContextIds: []};
    case "Target.createTarget":
      return {targetId: "page-target"};
    case "Page.getFrameTree":
      return {
        frameTree: {
          frame: {
            id: "main-frame",
            loaderId: "fixture-loader",
            url: "about:blank",
            domainAndRegistry: "",
            securityOrigin: "://",
            mimeType: "text/html",
            secureContextType: "Secure",
            crossOriginIsolatedContextType: "NotIsolated",
            gatedAPIFeatures: [],
          },
        },
      };
    case "Runtime.callFunctionOn":
      return {result: {type: "undefined"}};
    case "Page.addScriptToEvaluateOnNewDocument":
      return {identifier: "fixture-script"};
    case "Page.createIsolatedWorld":
      return {executionContextId: 2};
    case "Page.captureScreenshot":
      return {data: "Zml4dHVyZS1wbmc="};
    default:
      if (EMPTY_RESULT_METHODS.has(request.method)) return {};
      throw new Error(`Unmatched Browser CDP method: ${request.method}`);
  }
}

function send(socket: WebSocket, value: unknown): void {
  socket.send(JSON.stringify(value));
}

function attachCdp(socket: WebSocket): void {
  socket.accept();
  socket.addEventListener("message", event => {
    const request = JSON.parse(String(event.data)) as CdpRequest;
    let result: Record<string, unknown>;
    try {
      assertCdpRequest(request);
      result = cdpResult(request);
    } catch (error) {
      send(socket, {
        id: request.id,
        error: {code: -32601, message: error instanceof Error ? error.message : "Unmatched method"},
        ...(request.sessionId ? {sessionId: request.sessionId} : {}),
      });
      return;
    }
    operations.push(request.method);
    const reply = {
      id: request.id,
      result,
      ...(request.sessionId ? {sessionId: request.sessionId} : {}),
    };

    if (request.method === "Target.setDiscoverTargets") {
      send(socket, reply);
      return;
    }
    if (request.method === "Target.createTarget") {
      send(socket, {
        method: "Target.targetCreated",
        params: {targetInfo: {
          targetId: "page-target",
          type: "page",
          title: "",
          url: "about:blank",
          attached: false,
          canAccessOpener: false,
          browserContextId: "",
        }},
      });
      send(socket, {
        method: "Target.attachedToTarget",
        params: {
          sessionId: "page-session",
          targetInfo: {
            targetId: "page-target",
            type: "page",
            title: "",
            url: "about:blank",
            attached: true,
            canAccessOpener: false,
            browserContextId: "",
          },
          waitingForDebugger: false,
        },
      });
      send(socket, reply);
      return;
    }
    if (request.method === "Runtime.enable") {
      send(socket, {
        method: "Runtime.executionContextCreated",
        params: {context: {
          id: 1,
          origin: "",
          name: "",
          uniqueId: "fixture-main-world",
          auxData: {isDefault: true, type: "default", frameId: "main-frame"},
        }},
        ...(request.sessionId ? {sessionId: request.sessionId} : {}),
      });
    }
    send(socket, reply);
    if (request.method === "Runtime.callFunctionOn") {
      send(socket, {
        method: "Page.lifecycleEvent",
        params: {
          frameId: "main-frame",
          loaderId: "fixture-loader",
          name: "load",
          timestamp: 1,
        },
        ...(request.sessionId ? {sessionId: request.sessionId} : {}),
      });
      send(socket, {
        method: "Page.loadEventFired",
        params: {timestamp: 1},
        ...(request.sessionId ? {sessionId: request.sessionId} : {}),
      });
    }
    if (request.method === "Browser.close") socket.close(1000, "fixture close");
  });
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/__control" && request.method === "POST") {
      const body = await request.json<{scenario?: BrowserScenario}>();
      scenario = body.scenario === "ambiguous" ? "ambiguous" : "success";
      operations = [];
      nextCdpCommand = 0;
      activeSessionId = undefined;
      return json({ok: true});
    }
    if (url.pathname === "/__operations") {
      return json({
        scenario,
        operations,
        protocolComplete: scenario === "ambiguous" ||
          nextCdpCommand === EXPECTED_CDP_METHODS.length,
      });
    }
    if (url.pathname === "/v1/devtools/browser" && request.method === "POST") {
      if (url.search !== "") {
        return new Response("Unexpected Browser acquire parameters.", {status: 400});
      }
      operations.push("browser.acquire");
      if (scenario === "ambiguous") throw new Error("private-browser-response-loss");
      activeSessionId = `fixture-browser-${nextSession++}`;
      return json({sessionId: activeSessionId});
    }
    if (url.pathname === `/v1/devtools/browser/${activeSessionId}` &&
        request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      if (!request.headers.get("cf-brapi-client")?.startsWith("@cloudflare/puppeteer@")) {
        return new Response("Missing Browser client identity.", {status: 400});
      }
      operations.push("browser.connect");
      const pair = new WebSocketPair();
      attachCdp(pair[1]);
      return new Response(null, {status: 101, webSocket: pair[0]});
    }
    return new Response("Unmatched Browser Run mock request.", {status: 404});
  },
};
