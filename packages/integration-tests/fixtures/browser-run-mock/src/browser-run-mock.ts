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

let scenario: BrowserScenario = "success";
let operations: string[] = [];
let nextSession = 1;

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
    case "Page.getLayoutMetrics":
      return {
        cssLayoutViewport: {pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600},
        cssVisualViewport: {
          offsetX: 0,
          offsetY: 0,
          pageX: 0,
          pageY: 0,
          clientWidth: 800,
          clientHeight: 600,
          scale: 1,
          zoom: 1,
        },
        cssContentSize: {x: 0, y: 0, width: 800, height: 600},
      };
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
    operations.push(request.method);
    let result: Record<string, unknown>;
    try {
      result = cdpResult(request);
    } catch (error) {
      send(socket, {
        id: request.id,
        error: {code: -32601, message: error instanceof Error ? error.message : "Unmatched method"},
        ...(request.sessionId ? {sessionId: request.sessionId} : {}),
      });
      return;
    }
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
      return json({ok: true});
    }
    if (url.pathname === "/__operations") return json({scenario, operations});
    if (url.pathname === "/v1/devtools/browser" && request.method === "POST") {
      operations.push("browser.acquire");
      if (scenario === "ambiguous") throw new Error("private-browser-response-loss");
      return json({sessionId: `fixture-browser-${nextSession++}`});
    }
    if (url.pathname.startsWith("/v1/devtools/browser/") &&
        request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      operations.push("browser.connect");
      const pair = new WebSocketPair();
      attachCdp(pair[1]);
      return new Response(null, {status: 101, webSocket: pair[0]});
    }
    return new Response("Unmatched Browser Run mock request.", {status: 404});
  },
};
