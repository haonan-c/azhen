import { describe, expect, it } from "vitest";
import { publicInterfaceMethods } from "../test/gatekeeper-billing-contract";

describe("Gatekeeper billing surface parser", () => {
  it("reads public methods from TypeScript syntax with nested object types", () => {
    const source = `
      export interface RecordsSession {
        find(options: { filter: { tag: string } }): Promise<string[]>;
        update(input: { patch: { title?: string } }): Promise<void>;
      }
    `;

    expect(publicInterfaceMethods(source, ["RecordsSession"])).toEqual([
      "RecordsSession.find",
      "RecordsSession.update",
    ]);
  });

  it("includes inherited methods and callable properties", () => {
    const source = `
      interface BaseSession {
        find(): Promise<string[]>;
      }
      export interface RecordsSession extends RpcTarget, BaseSession {
        update: (input: string) => Promise<void>;
      }
    `;

    expect(publicInterfaceMethods(source, ["RecordsSession"])).toEqual([
      "RecordsSession.find",
      "RecordsSession.update",
    ]);
  });

  it("discovers callable capabilities reachable through return types", () => {
    const source = `
      export interface RootSession {
        open(): Promise<{ child: ChildSession }>;
      }
      interface ChildSession {
        read(): Promise<string>;
      }
    `;

    expect(publicInterfaceMethods(source, ["RootSession"])).toEqual([
      "RootSession.open",
      "ChildSession.read",
    ]);
  });

  it("discovers Hook capabilities passed through method parameters", () => {
    const source = `
      export interface RootSession {
        attach(hook: DeliveryHook): Promise<void>;
      }
      interface DeliveryHook {
        onDelivery(): Promise<void>;
      }
    `;

    expect(publicInterfaceMethods(source, ["RootSession"])).toEqual([
      "RootSession.attach",
      "DeliveryHook.onDelivery",
    ]);
  });

  it("rejects an unresolved inherited interface", () => {
    const source = "export interface RecordsSession extends ImportedSession {}";
    expect(() => publicInterfaceMethods(source, ["RecordsSession"]))
      .toThrow("RecordsSession inherits missing interface ImportedSession");
  });

  it("rejects a missing interface instead of accepting an empty surface", () => {
    expect(() => publicInterfaceMethods("export interface Present {}", ["Missing"]))
      .toThrow("missing interface Missing");
  });
});
