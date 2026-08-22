// A service-bound workerd Worker that implements the Home Assistant REST and WebSocket protocols
// used by the production Gatekeeper. It is booted only by the integration harness.

const TEST_TOKEN = "homeassistant-test-token-sentinel";

type MockCall = { transport: "rest" | "websocket"; operation: string };

let calls: MockCall[] = [];
let rejectNextAuthentication = false;
let dropNextCommand: string | undefined;
let failNextRestResponse = false;
let barrier: {
  transport?: MockCall["transport"];
  operation?: string;
  reached: boolean;
} | undefined;

function state(entityId: string, value: string) {
  return {
    entity_id: entityId,
    state: value,
    attributes: { friendly_name: `Fixture ${entityId}` },
    last_changed: "2026-08-22T00:00:00.000Z",
    last_updated: "2026-08-22T00:00:00.000Z",
    context: { id: "context-fixture", user_id: null, parent_id: null },
  };
}

const STATES = [
  state("light.kitchen", "on-state-sentinel"),
  state("sensor.temperature", "21-history-sentinel"),
];

async function record(call: MockCall): Promise<void> {
  calls.push(call);
  const pending = barrier;
  if (!pending ||
      (pending.transport !== undefined && pending.transport !== call.transport) ||
      (pending.operation !== undefined && pending.operation !== call.operation)) {
    return;
  }
  pending.reached = true;
  await new Promise(resolve => setTimeout(resolve, 2_000));
  if (barrier === pending) barrier = undefined;
}

function webSocketResult(type: string): unknown {
  switch (type) {
    case "config/area_registry/list":
      return [{ area_id: "living_room", name: "Living Room", floor_id: "ground" }];
    case "config/floor_registry/list":
      return [{ floor_id: "ground", name: "Ground Floor", level: 0 }];
    case "config/label_registry/list":
      return [{ label_id: "featured", name: "Featured" }];
    case "config/device_registry/list":
      return [{ id: "device-1", name: "Kitchen Device", area_id: "living_room" }];
    case "config/entity_registry/list":
      return [
        { entity_id: "light.kitchen", device_id: "device-1", labels: ["featured"] },
        { entity_id: "sensor.temperature", device_id: "device-1", labels: [] },
      ];
    case "lovelace/dashboards/list":
      return [{
        url_path: "dashboard-path-sentinel",
        title: "Overview",
        mode: "storage",
        show_in_sidebar: true,
        require_admin: false,
      }];
    case "lovelace/resources":
      return [{ id: "resource-1", url: "/local/card.js", type: "module" }];
    case "lovelace/config":
      return { views: [{ title: "dashboard-config-sentinel", cards: [] }] };
    default:
      return null;
  }
}

function openWebSocket(): Response {
  const pair = new WebSocketPair();
  const server = pair[0];
  const client = pair[1];
  server.accept();
  server.send(JSON.stringify({ type: "auth_required", ha_version: "2026.8.0" }));
  let authenticated = false;

  server.addEventListener("message", event => {
    void (async () => {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (!authenticated) {
        if (rejectNextAuthentication) {
          rejectNextAuthentication = false;
          server.send(JSON.stringify({ type: "auth_invalid", message: "fixture rejection" }));
          return;
        }
        if (message.type !== "auth" || message.access_token !== TEST_TOKEN) {
          server.send(JSON.stringify({ type: "auth_invalid", message: "bad token" }));
          return;
        }
        authenticated = true;
        server.send(JSON.stringify({ type: "auth_ok", ha_version: "2026.8.0" }));
        return;
      }

      const type = String(message.type);
      await record({ transport: "websocket", operation: type });
      if (dropNextCommand === type) {
        dropNextCommand = undefined;
        server.close(1011, "fixture response loss");
        return;
      }
      server.send(JSON.stringify({
        id: message.id,
        type: "result",
        success: true,
        result: webSocketResult(type),
      }));
    })();
  });

  return new Response(null, { status: 101, webSocket: client });
}

async function control(request: Request, url: URL): Promise<Response> {
  if (request.method === "GET" && url.pathname === "/control/calls") {
    return Response.json(calls);
  }
  if (request.method === "GET" && url.pathname === "/control/barrier") {
    return Response.json({ reached: barrier?.reached ?? false });
  }
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const body = await request.json() as Record<string, unknown>;
  switch (url.pathname) {
    case "/control/reset":
      calls = [];
      return new Response(null, { status: 204 });
    case "/control/reject-next-authentication":
      rejectNextAuthentication = true;
      return new Response(null, { status: 204 });
    case "/control/drop-next-command":
      dropNextCommand = String(body.type);
      return new Response(null, { status: 204 });
    case "/control/fail-next-rest-response":
      failNextRestResponse = true;
      return new Response(null, { status: 204 });
    case "/control/block-next": {
      barrier = {
        transport: body.transport as MockCall["transport"] | undefined,
        operation: typeof body.operation === "string" ? body.operation : undefined,
        reached: false,
      };
      return new Response(null, { status: 204 });
    }
    default:
      return new Response("Unknown control", { status: 404 });
  }
}

async function homeAssistantRest(request: Request, url: URL): Promise<Response> {
  await record({ transport: "rest", operation: `${request.method} ${url.pathname}` });
  if (failNextRestResponse) {
    failNextRestResponse = false;
    return Response.json({message: "mock-error-body-sentinel"}, {status: 500});
  }
  if (url.pathname === "/api/") return Response.json({ message: "API running." });
  if (url.pathname === "/api/config") {
    return Response.json({
      location_name: "HA Fixture",
      version: "2026.8.0",
      time_zone: "UTC",
      unit_system: { temperature: "°C" },
    });
  }
  if (url.pathname === "/api/states") return Response.json(STATES);
  if (url.pathname.startsWith("/api/states/")) {
    const entityId = decodeURIComponent(url.pathname.slice("/api/states/".length));
    return Response.json(STATES.find(candidate => candidate.entity_id === entityId) ??
      state(entityId, "dynamic-state-sentinel"));
  }
  if (url.pathname === "/api/services") {
    return Response.json([{
      domain: "light",
      services: { turn_on: { name: "Turn on", description: "Turn on a light." } },
    }]);
  }
  if (url.pathname === "/api/template") {
    return new Response("template-result-sentinel", {
      headers: { "content-type": "text/plain" },
    });
  }
  if (url.pathname.startsWith("/api/history/period/")) {
    const entityIds = (url.searchParams.get("filter_entity_id") ?? "light.kitchen").split(",");
    return Response.json(entityIds.map(entityId =>
      [state(entityId, "history-state-sentinel")]));
  }
  if (url.pathname.startsWith("/api/logbook/")) {
    return Response.json([{
      when: "2026-08-22T00:00:00.000Z",
      name: "Fixture event",
      message: "logbook-message-sentinel",
      entity_id: url.searchParams.get("entity") ?? "light.kitchen",
    }]);
  }
  return Response.json({ message: "mock-error-body-sentinel" }, { status: 404 });
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/control/")) return control(request, url);
    if (url.pathname === "/api/websocket" && request.headers.get("upgrade") === "websocket") {
      return openWebSocket();
    }
    return homeAssistantRest(request, url);
  },
};
