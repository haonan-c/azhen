/** One fixed-rate Home Assistant caller-visible read operation. */
export type HomeAssistantBillingMethod = {
  /** Stable deployment pricing key. This value must not be derived from runtime input. */
  methodKey: string;
  /** Rates apply to a complete caller-visible operation, not an internal transport call. */
  rateUnit: "operation";
  /** Every invocation records one operation, independent of response size or internal fan-out. */
  quantity: 1;
};

function operation(methodKey: string): HomeAssistantBillingMethod {
  return { methodKey, rateUnit: "operation", quantity: 1 };
}

/**
 * Stable billing registry for every public Home Assistant read that currently reaches upstream.
 *
 * Existing keys are persistent Usage Rate and Usage Record identifiers. Do not rename a key when
 * an implementation class, helper, URL, or Home Assistant transport command changes.
 */
export const HOME_ASSISTANT_BILLING_METHODS = {
  "HomeAssistantSession.getConfig": operation("homeassistant.instance.get-config"),
  "HomeAssistantSession.listAreas": operation("homeassistant.instance.list-areas"),
  "HomeAssistantSession.listFloors": operation("homeassistant.instance.list-floors"),
  "HomeAssistantSession.listLabels": operation("homeassistant.instance.list-labels"),
  "HomeAssistantSession.listDevices": operation("homeassistant.instance.list-devices"),
  "HomeAssistantSession.listEntities": operation("homeassistant.instance.list-entities"),
  "HomeAssistantSession.listDomains": operation("homeassistant.instance.list-domains"),
  "HomeAssistantSession.listServices": operation("homeassistant.instance.list-services"),
  "HomeAssistantSession.getArea": operation("homeassistant.instance.get-area"),
  "HomeAssistantSession.getLabel": operation("homeassistant.instance.get-label"),
  "HomeAssistantSession.getDevice": operation("homeassistant.instance.get-device"),
  "HomeAssistantSession.getEntity": operation("homeassistant.instance.get-entity"),
  "HomeAssistantSession.renderTemplate": operation("homeassistant.instance.render-template"),
  "HomeAssistantSession.getHistory": operation("homeassistant.instance.get-history"),
  "HomeAssistantSession.getLogbook": operation("homeassistant.instance.get-logbook"),
  "HomeAssistantSession.listDashboards": operation("homeassistant.instance.list-dashboards"),
  "HomeAssistantSession.listLovelaceResources": operation(
    "homeassistant.instance.list-lovelace-resources",
  ),
  "Area.describe": operation("homeassistant.area.describe"),
  "Area.getFloor": operation("homeassistant.area.get-floor"),
  "Area.listEntities": operation("homeassistant.area.list-entities"),
  "Area.listDevices": operation("homeassistant.area.list-devices"),
  "Area.getEntity": operation("homeassistant.area.get-entity"),
  "Area.getDevice": operation("homeassistant.area.get-device"),
  "Area.getHistory": operation("homeassistant.area.get-history"),
  "Label.describe": operation("homeassistant.label.describe"),
  "Label.listEntities": operation("homeassistant.label.list-entities"),
  "Label.getEntity": operation("homeassistant.label.get-entity"),
  "Label.getHistory": operation("homeassistant.label.get-history"),
  "Device.describe": operation("homeassistant.device.describe"),
  "Device.getArea": operation("homeassistant.device.get-area"),
  "Device.listEntities": operation("homeassistant.device.list-entities"),
  "Device.getEntity": operation("homeassistant.device.get-entity"),
  "Device.getHistory": operation("homeassistant.device.get-history"),
  "Entity.describe": operation("homeassistant.entity.describe"),
  "Entity.getState": operation("homeassistant.entity.get-state"),
  "Entity.getDevice": operation("homeassistant.entity.get-device"),
  "Entity.getArea": operation("homeassistant.entity.get-area"),
  "Entity.getLabels": operation("homeassistant.entity.get-labels"),
  "Entity.getHistory": operation("homeassistant.entity.get-history"),
  "Entity.getLogbook": operation("homeassistant.entity.get-logbook"),
  "Dashboard.describe": operation("homeassistant.dashboard.describe"),
  "Dashboard.getConfig": operation("homeassistant.dashboard.get-config"),
} as const satisfies Record<string, HomeAssistantBillingMethod>;

/** Public reads that are intentionally local and therefore create no Metering Attempt. */
export const HOME_ASSISTANT_LOCAL_READ_METHODS = [
  "HomeAssistantSession.getDashboard",
] as const;

/** A public Home Assistant read that reaches the upstream instance. */
export type HomeAssistantBillableReadMethod = keyof typeof HOME_ASSISTANT_BILLING_METHODS;
