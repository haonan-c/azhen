import {setupNetwork} from "@msw/cloudflare";
import {afterAll, afterEach, beforeAll, describe, expect, it} from "vitest";
import {ws} from "msw";
import {HomeAssistantWebSocket} from "../src/homeassistant-api.js";

const network = setupNetwork();

beforeAll(() => network.enable());
afterEach(() => network.resetHandlers());
afterAll(() => network.disable());

describe("Home Assistant default WebSocket transport", () => {
  it("uses the production WebSocket path in workerd", async () => {
    expect(navigator.userAgent).toBe("Cloudflare-Workers");
    const homeAssistant = ws.link("ws://ha.example/api/websocket");
    network.use(homeAssistant.addEventListener("connection", ({client}) => {
      client.addEventListener("message", event => {
        const message = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (message.type === "auth") {
          client.send(JSON.stringify({type: "auth_ok", ha_version: "2026.8.0"}));
          return;
        }
        client.send(JSON.stringify({
          id: message.id,
          type: "result",
          success: true,
          result: [{area_id: "living_room"}],
        }));
      });
      client.send(JSON.stringify({type: "auth_required", ha_version: "2026.8.0"}));
    }));

    const socket = await HomeAssistantWebSocket.connect({
      baseUrl: "http://ha.example",
      token: "fake-token",
    });
    await expect(socket.send({ type: "config/area_registry/list" })).resolves.toEqual([
      { area_id: "living_room" },
    ]);
    await socket.close();
  });
});
