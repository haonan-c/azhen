import { describe, expect, it } from "vitest";
import {
  HOME_ASSISTANT_BILLING_METHODS,
  HOME_ASSISTANT_LOCAL_READ_METHODS,
} from "../src/billing-methods.js";

const EXPECTED_METHOD_KEYS = [
  "homeassistant.instance.get-config",
  "homeassistant.instance.list-areas",
  "homeassistant.instance.list-floors",
  "homeassistant.instance.list-labels",
  "homeassistant.instance.list-devices",
  "homeassistant.instance.list-entities",
  "homeassistant.instance.list-domains",
  "homeassistant.instance.list-services",
  "homeassistant.instance.get-area",
  "homeassistant.instance.get-label",
  "homeassistant.instance.get-device",
  "homeassistant.instance.get-entity",
  "homeassistant.instance.render-template",
  "homeassistant.instance.get-history",
  "homeassistant.instance.get-logbook",
  "homeassistant.instance.list-dashboards",
  "homeassistant.instance.list-lovelace-resources",
  "homeassistant.area.describe",
  "homeassistant.area.get-floor",
  "homeassistant.area.list-entities",
  "homeassistant.area.list-devices",
  "homeassistant.area.get-entity",
  "homeassistant.area.get-device",
  "homeassistant.area.get-history",
  "homeassistant.label.describe",
  "homeassistant.label.list-entities",
  "homeassistant.label.get-entity",
  "homeassistant.label.get-history",
  "homeassistant.device.describe",
  "homeassistant.device.get-area",
  "homeassistant.device.list-entities",
  "homeassistant.device.get-entity",
  "homeassistant.device.get-history",
  "homeassistant.entity.describe",
  "homeassistant.entity.get-state",
  "homeassistant.entity.get-device",
  "homeassistant.entity.get-area",
  "homeassistant.entity.get-labels",
  "homeassistant.entity.get-history",
  "homeassistant.entity.get-logbook",
  "homeassistant.dashboard.describe",
  "homeassistant.dashboard.get-config",
] as const;

describe("Home Assistant Billable Method inventory", () => {
  it("fixes the complete 42-method read registry", () => {
    const entries = Object.values(HOME_ASSISTANT_BILLING_METHODS);

    expect(entries).toHaveLength(42);
    expect(new Set(entries.map(entry => entry.methodKey)).size).toBe(42);
    expect(entries.map(entry => entry.methodKey)).toEqual(EXPECTED_METHOD_KEYS);
    expect(entries.every(entry => entry.rateUnit === "operation" && entry.quantity === 1))
      .toBe(true);
  });

  it("keeps the local-only capability accessor outside billing", () => {
    expect(HOME_ASSISTANT_LOCAL_READ_METHODS).toEqual([
      "HomeAssistantSession.getDashboard",
    ]);
    expect(Object.keys(HOME_ASSISTANT_BILLING_METHODS)).not.toContain(
      "HomeAssistantSession.getDashboard",
    );
  });

  it("does not register write or Action methods", () => {
    const publicMethods = Object.keys(HOME_ASSISTANT_BILLING_METHODS);
    for (const excluded of [
      "HomeAssistantSession.callService",
      "HomeAssistantSession.fireEvent",
      "Area.callService",
      "Label.callService",
      "Device.callService",
      "Entity.callService",
      "Dashboard.saveConfig",
    ]) {
      expect(publicMethods).not.toContain(excluded);
    }
  });
});
