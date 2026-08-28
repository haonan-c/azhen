import {createHash} from "node:crypto";
import {mkdir, writeFile} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {spawn} from "node:child_process";
import {
  buildCapacityChildEnvironment,
  prepareCapacityLogForPersistence,
  scanCapacityLog,
  validateCapacityResult,
} from "./usage-capacity-result.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const args = process.argv.slice(2);
const smoke = args.includes("--smoke");
const full = args.includes("--full");
if (smoke === full) {
  throw new TypeError("Exactly one of --smoke or --full is required.");
}
const mode = smoke ? "smoke" : "full";
const outputIndex = args.indexOf("--out");
if (outputIndex >= 0 && args[outputIndex + 1] === undefined) {
  throw new TypeError("--out requires a directory.");
}
const runStamp = new Date().toISOString().replaceAll(":", "-");
const outputDirectory = outputIndex >= 0
  ? resolve(process.cwd(), args[outputIndex + 1])
  : join(ROOT, "docs/implementation/usage-credits/issue-66/capacity", runStamp);
await mkdir(outputDirectory, {recursive: true});

const chunks = [];
const commands = [
  ...smoke ? [] : [
    {
      name: "capnweb-backend",
      args: [
        "pnpm", "--filter", "@gadgets/workshop-backend", "exec", "vitest", "run",
        "--config", "vitest.integration.config.ts",
        "__integration__/open-gadget-rpc.test.ts",
        "__integration__/usage-account-rpc.test.ts",
        "__integration__/usage-projection-rpc.test.ts",
      ],
    },
    {
      name: "capnweb-report-stream",
      args: [
        "pnpm", "--filter", "@gadgets/integration-tests", "exec", "vitest", "run",
        "__tests__/action-billing.test.ts",
      ],
    },
  ],
  {
    name: "capacity",
    args: [
      "pnpm", "--filter", "@gadgets/workshop-backend", "exec", "vitest", "run",
      "--config", "vitest.usage-capacity.config.ts",
    ],
  },
];
const stepExitCodes = {};
for (const command of commands) {
  const heading = Buffer.from(`\nUSAGE_CAPACITY_STEP=${command.name}\n`);
  chunks.push(heading);
  process.stdout.write(heading);
  const child = spawn("corepack", command.args, {
    cwd: ROOT,
    env: buildCapacityChildEnvironment(process.env, mode),
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", chunk => {
      const buffered = Buffer.from(chunk);
      chunks.push(buffered);
      process.stdout.write(prepareCapacityLogForPersistence(
        buffered.toString("utf8"),
      ).content);
    });
  }
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", code => resolveExit(code ?? 1));
  });
  stepExitCodes[command.name] = exitCode;
  if (exitCode !== 0) break;
}
const log = Buffer.concat(chunks).toString("utf8");
const logPath = join(outputDirectory, "usage-capacity-v1.log");
const marker = /USAGE_CAPACITY_RESULT_BASE64=([A-Za-z0-9+/=]+)/.exec(log)?.[1];
const failures = [];
for (const [step, exitCode] of Object.entries(stepExitCodes)) {
  if (exitCode !== 0) failures.push(`${step} exit was ${exitCode}`);
}
if (Object.keys(stepExitCodes).length !== commands.length) {
  failures.push("one or more formal steps did not run");
}
if (marker === undefined) failures.push("result marker is missing");
let result = null;
let parsedResult = null;
if (marker !== undefined) {
  try {
    result = Buffer.from(marker, "base64").toString("utf8");
    parsedResult = JSON.parse(result);
    failures.push(...validateCapacityResult(parsedResult, mode));
  } catch (error) {
    failures.push(`result marker is invalid: ${error instanceof Error ? error.message : error}`);
  }
}
const resultPath = join(outputDirectory, "usage-capacity-v1.json");
const privacyFindings = scanCapacityLog(`${log}\n${result ?? ""}`);
if (privacyFindings.length > 0) failures.push("capacity log failed the privacy scan");
const persistedLog = prepareCapacityLogForPersistence(log).content;
await writeFile(logPath, persistedLog);
const artifacts = [{path: logPath, content: persistedLog}];
if (result !== null && parsedResult !== null && privacyFindings.length === 0) {
  const resultContent = `${result}\n`;
  await writeFile(resultPath, resultContent);
  artifacts.push({path: resultPath, content: resultContent});
}
const privacyPath = join(outputDirectory, "privacy-scan.json");
const privacyContent = `${JSON.stringify({
  pass: privacyFindings.length === 0,
  findings: privacyFindings,
  scannedArtifacts: result === null || privacyFindings.length > 0
    ? ["usage-capacity-v1.log"]
    : ["usage-capacity-v1.log", "usage-capacity-v1.json"],
})}\n`;
await writeFile(privacyPath, privacyContent);
artifacts.push({path: privacyPath, content: privacyContent});
const hashes = artifacts.map(({path, content}) => {
  return `${createHash("sha256").update(content).digest("hex")}  ${path}`;
}).join("\n");
await writeFile(join(outputDirectory, "SHA256SUMS"), `${hashes}\n`);
if (failures.length > 0) {
  throw new Error(
    `usage-capacity-v1 failed: ${failures.join("; ")}; raw log: ${logPath}`,
  );
}
console.log(`usage-capacity-v1 artifacts: ${outputDirectory}`);
