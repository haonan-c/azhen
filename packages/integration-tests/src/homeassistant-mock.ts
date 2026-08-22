import type { Harness } from "./harness";

export const HOME_ASSISTANT_TEST_TOKEN = "homeassistant-test-token-sentinel";

export type HomeAssistantMockCall = {
  transport: "rest" | "websocket";
  operation: string;
};

const WORKER_NAME = "homeassistant-upstream";

/** Controller for the service-bound workerd Home Assistant protocol fixture. */
export class HomeAssistantMock {
  readonly baseUrl = "http://homeassistant.test";

  constructor(private readonly harness: Harness) {}

  async calls(): Promise<HomeAssistantMockCall[]> {
    const response = await this.#fetch("/control/calls");
    if (!response.ok) throw new Error(`Failed to read mock calls: ${response.status}`);
    return await response.json() as HomeAssistantMockCall[];
  }

  async resetCalls(): Promise<void> {
    await this.#post("/control/reset", {});
  }

  async rejectNextWebSocketAuthentication(): Promise<void> {
    await this.#post("/control/reject-next-authentication", {});
  }

  async dropNextWebSocketCommand(type: string): Promise<void> {
    await this.#post("/control/drop-next-command", { type });
  }

  async failNextRestResponse(): Promise<void> {
    await this.#post("/control/fail-next-rest-response", {});
  }

  async blockNextRequest(options: {
    transport?: HomeAssistantMockCall["transport"];
    operation?: string;
  } = {}): Promise<void> {
    await this.#post("/control/block-next", options);
  }

  #fetch(path: string): ReturnType<Harness["fetchWorker"]> {
    return this.harness.fetchWorker(WORKER_NAME, new URL(path, this.baseUrl).toString());
  }

  async #post(path: string, body: unknown): Promise<void> {
    const response = await this.harness.fetchWorker(
      WORKER_NAME,
      new URL(path, this.baseUrl).toString(),
      { method: "POST", body: JSON.stringify(body) },
    );
    if (!response.ok) throw new Error(`Home Assistant mock control failed: ${response.status}`);
  }
}
