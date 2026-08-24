import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";
import {
  runBillableAction,
  runBillableRead,
  type BillableActionStorage,
} from "../src/gatekeeper-billing";
import type {
  ActionBilling,
  ActionExecution,
  BillableOperationOutcome,
  ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";

type ProgramStatement = ReturnType<typeof parse>["program"]["body"][number];
type InterfaceDeclaration = Extract<ProgramStatement, { type: "TSInterfaceDeclaration" }>;
type TypeAliasDeclaration = Extract<ProgramStatement, { type: "TSTypeAliasDeclaration" }>;

/** One exhaustive public Gatekeeper method classification from the usage-credit oracle. */
export type BillingSurfaceClass =
  | "R"
  | "A"
  | "H"
  | { kind: "C" | "K"; reason: string };

/** Read the declared public methods of selected TypeScript interfaces with the compiler AST. */
export function publicInterfaceMethods(
  source: string | readonly string[],
  interfaces: readonly string[],
): string[] {
  const declarations = new Map<string, InterfaceDeclaration[]>();
  const aliases = new Map<string, TypeAliasDeclaration>();
  for (const moduleSource of typeof source === "string" ? [source] : source) {
    const program = parse(moduleSource, {
      sourceType: "module", plugins: ["typescript", "decorators-legacy"],
    }).program;
    for (const statement of program.body) {
      const declaration = statement.type === "ExportNamedDeclaration"
        ? statement.declaration
        : statement;
      if (declaration?.type === "TSInterfaceDeclaration") {
        const existing = declarations.get(declaration.id.name) ?? [];
        existing.push(declaration);
        declarations.set(declaration.id.name, existing);
      } else if (declaration?.type === "TSTypeAliasDeclaration") {
        aliases.set(declaration.id.name, declaration);
      }
    }
  }

  const methods = new Set<string>();
  const visited = new Set<string>();
  const visitedAliases = new Set<string>();
  const discoverType = (node: unknown) => {
    if (typeof node !== "object" || node === null) return;
    if (Array.isArray(node)) {
      for (const child of node) discoverType(child);
      return;
    }
    const record = node as Record<string, unknown>;
    if (record.type === "TSTypeReference") {
      const typeName = record.typeName as { type?: string; name?: string } | undefined;
      if (typeName?.type === "Identifier" && typeName.name) {
        if (declarations.has(typeName.name)) collect(typeName.name, typeName.name);
        const alias = aliases.get(typeName.name);
        if (alias && !visitedAliases.has(typeName.name)) {
          visitedAliases.add(typeName.name);
          discoverType(alias.typeAnnotation);
        }
      }
    }
    for (const [key, value] of Object.entries(record)) {
      if (key !== "loc" && key !== "start" && key !== "end") discoverType(value);
    }
  };
  const collect = (interfaceName: string, exposedAs: string) => {
    if (visited.has(`${exposedAs}:${interfaceName}`)) return;
    visited.add(`${exposedAs}:${interfaceName}`);
    const matches = declarations.get(interfaceName);
    if (!matches) throw new Error(`missing interface ${interfaceName}`);
    for (const declaration of matches) {
      for (const base of declaration.extends ?? []) {
        if (base.expression.type !== "Identifier") {
          throw new Error(`${interfaceName} has an unsupported inherited interface`);
        }
        const baseName = base.expression.name;
        if (baseName === "RpcTarget") continue;
        if (!declarations.has(baseName)) {
          throw new Error(`${interfaceName} inherits missing interface ${baseName}`);
        }
        collect(baseName, exposedAs);
      }
      for (const member of declaration.body.body) {
        const callable = member.type === "TSMethodSignature" ||
          (member.type === "TSPropertySignature" &&
            member.typeAnnotation?.typeAnnotation.type === "TSFunctionType");
        if (!callable) continue;
        if (member.key.type !== "Identifier") {
          throw new Error(`${interfaceName} has a non-identifier public method`);
        }
        methods.add(`${exposedAs}.${member.key.name}`);
        if (member.type === "TSMethodSignature") {
          discoverType(member.typeAnnotation);
          for (const parameter of member.parameters) discoverType(parameter.typeAnnotation);
        } else if (member.typeAnnotation?.typeAnnotation.type === "TSFunctionType") {
          discoverType(member.typeAnnotation.typeAnnotation.typeAnnotation);
          for (const parameter of member.typeAnnotation.typeAnnotation.parameters) {
            discoverType(parameter.typeAnnotation);
          }
        }
      }
      for (const member of declaration.body.body) {
        if (member.type === "TSPropertySignature" &&
            member.typeAnnotation?.typeAnnotation.type !== "TSFunctionType") {
          discoverType(member.typeAnnotation);
        }
      }
    }
  };
  for (const interfaceName of interfaces) {
    collect(interfaceName, interfaceName);
  }
  return [...methods];
}

/**
 * Verify that every method in selected public Session interfaces is classified exactly once and
 * that every billable method, but no control or continuation method, has a registry entry.
 */
export function testPublicBillingSurface(
  vendor: string,
  typesSource: string | readonly string[],
  interfaces: readonly string[],
  classification: Readonly<Record<string, BillingSurfaceClass>>,
  billingRegistry: Readonly<Record<string, { methodKey: string }>>,
): void {
  describe(`${vendor} public billing surface`, () => {
    it("exhaustively classifies every public Session method", () => {
      const methods = publicInterfaceMethods(typesSource, interfaces);
      expect(Object.keys(classification)).toHaveLength(methods.length);
      expect(Object.keys(classification)).toEqual(expect.arrayContaining(methods));
      const billable = Object.entries(classification)
        .filter(([, entry]) => entry === "R" || entry === "A" || entry === "H")
        .map(([method]) => method);
      expect(Object.keys(billingRegistry)).toHaveLength(billable.length);
      expect(Object.keys(billingRegistry)).toEqual(expect.arrayContaining(billable));
      const allowlist = Object.values(classification)
        .filter((entry): entry is Extract<BillingSurfaceClass, object> => typeof entry === "object");
      expect(allowlist.every(entry => entry.reason.trim().length >= 20)).toBe(true);
      expect(Object.values(billingRegistry).every(({ methodKey }) =>
        /^[A-Za-z0-9@][A-Za-z0-9._:/@-]{0,199}$/.test(methodKey),
      )).toBe(true);
      const methodKeys = Object.values(billingRegistry).map(({ methodKey }) => methodKey);
      expect(new Set(methodKeys).size).toBe(methodKeys.length);
    });

  });
}

class MemoryActionStorage implements BillableActionStorage {
  readonly rows = new Map<string, unknown>();
  get<T>(key: string): T | undefined { return this.rows.get(key) as T | undefined; }
  put<T>(key: string, value: T): void { this.rows.set(key, value); }
  async sync(): Promise<void> {}
  transaction(callback: () => void): void { callback(); }
}

function execution(id: string): ActionExecution {
  return { billingOperationId: id, mode: "execute" };
}

/** Add the shared lifecycle checks to one migrated Gatekeeper package's test suite. */
export function testGatekeeperBillingContract(
  vendor: string,
  readMethodKey: string,
  actionBilling?: ActionBilling,
): void {
  describe(`${vendor} billing lifecycle`, () => {
    it("completes a successful read with its billing operation ID", async () => {
      const outcomes: BillableOperationOutcome[] = [];
      const descriptions: ObservationDescription[] = [];
      const result = await runBillableRead(
        {
          beginBillableOperation: async (methodKey, accountId) => {
            expect({ methodKey, accountId }).toEqual({ methodKey: readMethodKey, accountId: "acct" });
            return {
              async getOperationId() { return "read-1"; },
              async markStarted() {},
              async complete(outcome) { outcomes.push(outcome); },
              [Symbol.dispose]() {},
            };
          },
          async authorizeObservation(description) { descriptions.push(description); },
        },
        "acct",
        readMethodKey,
        async activity => {
          activity.requestDispatched();
          activity.responseReceived(200);
          return "ok";
        },
        () => ({ title: "Read", description: "Read provider data." }),
      );
      expect(result).toBe("ok");
      expect(outcomes).toEqual(["executed"]);
      expect(descriptions[0]?.billingOperationId).toBe("read-1");
    });

    it("classifies read failures before and after dispatch", async () => {
      const outcomes: BillableOperationOutcome[] = [];
      const authorizer = {
        async beginBillableOperation() {
          return {
            async getOperationId() { return "read-failure"; },
            async markStarted() {},
            async complete(outcome: BillableOperationOutcome) { outcomes.push(outcome); },
            [Symbol.dispose]() {},
          };
        },
        async authorizeObservation() {},
      };
      await expect(runBillableRead(
        authorizer, "acct", readMethodKey, async () => { throw new Error("invalid"); },
        () => ({ title: "Read", description: "Read provider data." }),
      )).rejects.toThrow("invalid");
      await expect(runBillableRead(
        authorizer, "acct", readMethodKey, async activity => {
          activity.requestDispatched();
          throw new Error("network");
        },
        () => ({ title: "Read", description: "Read provider data." }),
      )).rejects.toThrow("network");
      expect(outcomes).toEqual(["failed-before-execution", "unknown"]);
    });

    if (actionBilling) {
      it("applies an approved Action once and preserves duplicate unknown outcomes", async () => {
        expect(actionBilling.externalAccountId).toBe("account-1");
        const storage = new MemoryActionStorage();
        let calls = 0;
        const options = (run: ActionExecution) => ({
          storage,
          actionId: 7,
          execution: run,
          getPending: () => ({ approved: true }),
          removePending() {},
          async prepare(action: { approved: boolean }) { return action; },
          async execute(_action: { approved: boolean }, activity: { requestDispatched(): void }) {
            calls++;
            activity.requestDispatched();
            throw new Error("connection lost");
          },
        });
        expect(calls).toBe(0);
        expect(await runBillableAction(options(execution("action-1")))).toEqual({ outcome: "unknown" });
        expect(await runBillableAction(options(execution("action-1")))).toEqual({ outcome: "unknown" });
        expect(calls).toBe(1);

        const missing = await runBillableAction({
          ...options(execution("action-2")),
          getPending: () => undefined,
        });
        expect(missing).toEqual({ outcome: "failed-before-execution" });
      });
    }
  });
}
