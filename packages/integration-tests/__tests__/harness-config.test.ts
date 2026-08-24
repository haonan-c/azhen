import {expect, it} from "vitest";
import {inlineWorker, type WorkerConfig} from "../src/harness.js";

it("isolates inline Worker bindings from the harness root development variables", () => {
  const config = {
    name: "binding-isolation-fixture",
    main: "/fixture/worker.ts",
    vars: {
      FIXTURE_TOKEN: "fixture-value",
      ADMINS: ["fixture-admin"],
    },
  } satisfies WorkerConfig;

  const worker = inlineWorker(config);

  expect(worker.config).toEqual({
    ...config,
    secrets: {required: []},
  });
  expect(worker.vars).toEqual(config.vars);
  expect(worker.secrets).toEqual({FIXTURE_TOKEN: "fixture-value"});
  expect(worker.vars).not.toHaveProperty("UNDECLARED_LOCAL_SECRET");
  expect(worker.secrets).not.toHaveProperty("UNDECLARED_LOCAL_SECRET");
});
