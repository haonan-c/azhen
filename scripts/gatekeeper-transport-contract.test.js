import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript6";

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPTS, "..");
const PACKAGES = join(ROOT, "packages");
const ALLOWLIST = join(SCRIPTS, "gatekeeper-transport-allowlist.json");

function sourceFiles(path) {
  const files = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(child));
    } else if ((entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
        !entry.name.endsWith(".d.ts")) {
      files.push(child);
    }
  }
  return files;
}

function unwrapExpression(node) {
  while (ts.isAwaitExpression(node) || ts.isParenthesizedExpression(node)) node = node.expression;
  return node;
}

function directReceiverName(expression) {
  let current = expression;
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = current.expression;
  }
  return ts.isIdentifier(current) ? current.text : undefined;
}

function calledProperty(expression) {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression) &&
      expression.argumentExpression &&
      (ts.isStringLiteral(expression.argumentExpression) ||
        ts.isNoSubstitutionTemplateLiteral(expression.argumentExpression))) {
    return expression.argumentExpression.text;
  }
}

function transportCalls(path, sourceText = readFileSync(path, "utf8")) {
  const source = ts.createSourceFile(
      path,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const sites = [];
  const enclosingName = (node) => {
    for (let current = node.parent; current; current = current.parent) {
      if (ts.isMethodDeclaration(current)) return current.name.getText(source);
      if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
      if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
          ts.isVariableDeclaration(current.parent) &&
          ts.isIdentifier(current.parent.name)) {
        return current.parent.name.text;
      }
    }
    return "<module>";
  };
  const record = (node, kind, expression) => {
    sites.push(`${kind}:${enclosingName(node)}:${expression}`);
  };
  const bindingAliases = new Set();
  const bindingProperties = new Set();
  const directBinding = (text) =>
    /(?:^|\.)env(?:\.[A-Z][A-Z0-9_]*|\[["'][A-Z][A-Z0-9_]*["']\])$/.test(text);
  const envObject = (text) => /(?:^|\.)env$/.test(text);
  const bindingReceiver = (expression) => {
    const direct = directReceiverName(expression);
    if (direct !== undefined && bindingAliases.has(direct)) return true;
    if ((ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) &&
        expression.expression.kind === ts.SyntaxKind.ThisKeyword) {
      const property = calledProperty(expression);
      return property !== undefined && bindingProperties.has(property);
    }
    return false;
  };
  const rejectTransportAlias = (node, expression) => {
    const name = calledProperty(expression);
    const text = expression.getText(source);
    if (ts.isIdentifier(expression) && ["fetch", "launch"].includes(expression.text) ||
        name !== undefined && ["fetch", "launch", "send", "onSchedule"].includes(name)) {
      assert.fail(`${path}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1} ` +
        `aliases transport ${text}; direct transport aliases are not allowed`);
    }
  };
  const collectBindingAliases = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const initializer = unwrapExpression(node.initializer);
      const text = initializer.getText(source);
      const receiver = ts.isCallExpression(initializer)
        ? directReceiverName(initializer.expression) : directReceiverName(initializer);
      const method = ts.isCallExpression(initializer)
        ? calledProperty(initializer.expression) : undefined;
      const callUsesBinding = ts.isCallExpression(initializer) &&
        (ts.isPropertyAccessExpression(initializer.expression) ||
          ts.isElementAccessExpression(initializer.expression)) &&
        bindingReceiver(initializer.expression.expression);
      if (directBinding(text) ||
          text.includes("#artifacts().get") ||
          (receiver !== undefined && bindingAliases.has(receiver) ||
            callUsesBinding) &&
            (method === "get" || method === "getByName")) {
        bindingAliases.add(node.name.text);
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) &&
        node.initializer && envObject(unwrapExpression(node.initializer).getText(source))) {
      for (const element of node.name.elements) {
        const property = (element.propertyName ?? element.name).getText(source)
            .replace(/^["']|["']$/g, "");
        if (/^[A-Z][A-Z0-9_]*$/.test(property) && ts.isIdentifier(element.name)) {
          bindingAliases.add(element.name.text);
        }
      }
    }
    if (ts.isPropertyDeclaration(node) && node.initializer &&
        directBinding(unwrapExpression(node.initializer).getText(source))) {
      const property = node.name.getText(source).replace(/^["']|["']$/g, "");
      bindingProperties.add(property);
    }
    if (ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        directBinding(unwrapExpression(node.right).getText(source))) {
      if (ts.isIdentifier(node.left)) bindingAliases.add(node.left.text);
      else if ((ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left)) &&
          node.left.expression.kind === ts.SyntaxKind.ThisKeyword) {
        const property = calledProperty(node.left);
        if (property) bindingProperties.add(property);
      }
    }
    ts.forEachChild(node, collectBindingAliases);
  };
  for (;;) {
    const previousSize = bindingAliases.size + bindingProperties.size;
    collectBindingAliases(source);
    if (bindingAliases.size + bindingProperties.size === previousSize) break;
  }
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name)) rejectTransportAlias(node, node.initializer);
      if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          const property = element.propertyName ?? element.name;
          const name = property.getText(source).replace(/^["']|["']$/g, "");
          if (["fetch", "launch", "send", "onSchedule"].includes(name)) {
            assert.fail(`${path}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1} ` +
              `destructures transport ${name}; direct transport aliases are not allowed`);
          }
        }
      }
    }
    if (ts.isCallExpression(node)) {
      const expression = node.expression.getText(source);
      const property = calledProperty(node.expression);
      if (ts.isIdentifier(node.expression) && node.expression.text === "fetch" ||
          property === "fetch") {
        record(node, "fetch", expression);
      } else if (ts.isIdentifier(node.expression) && node.expression.text === "launch") {
        record(node, "browser", expression);
      } else if (property === "send") {
        record(node, "send", expression);
      } else if (property === "onSchedule") {
        record(node, "hook", expression);
      } else if ((ts.isPropertyAccessExpression(node.expression) ||
          ts.isElementAccessExpression(node.expression)) &&
          !ts.isCallExpression(node.expression.expression) &&
          /(?:^|\.)env(?:\.[A-Z][A-Z0-9_]*|\[["'][A-Z][A-Z0-9_]*["']\])(?:\.|\[)/
              .test(expression)) {
        record(node, "service-binding", expression);
      } else if ((ts.isPropertyAccessExpression(node.expression) ||
          ts.isElementAccessExpression(node.expression)) &&
          (bindingReceiver(node.expression.expression) ||
            expression.includes("#artifacts()."))) {
        record(node, "service-binding", expression);
      }
    }
    if (ts.isNewExpression(node) &&
        ["WebSocket", "globalThis.WebSocket", "globalThis[\"WebSocket\"]",
          "globalThis['WebSocket']"].includes(node.expression.getText(source))) {
      record(node, "websocket", node.expression.getText(source));
    }
    if (ts.isMethodDeclaration(node) &&
        ["alarm", "email", "fetch", "scheduled"].includes(node.name.getText(source))) {
      const name = node.name.getText(source);
      sites.push(`entrypoint:${name}:${name}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites.toSorted();
}

test("transport inventory rejects aliases and records computed transport properties", () => {
  assert.throws(() => transportCalls("alias.ts", "const request = fetch; request('https://x');"),
      /aliases transport fetch/);
  assert.throws(() => transportCalls("alias.ts", "const { launch: start } = env.BROWSER;"),
      /destructures transport launch/);
  assert.deepEqual(transportCalls("computed.ts", `
    async function run(ws) {
      ws["send"]("message");
      await globalThis["fetch"]("https://example.test");
      new globalThis["WebSocket"]("wss://example.test");
      env["STORE"]["get"]("key");
    }
  `), [
    "fetch:run:globalThis[\"fetch\"]",
    "send:run:ws[\"send\"]",
    "service-binding:run:env[\"STORE\"][\"get\"]",
    "websocket:run:globalThis[\"WebSocket\"]",
  ]);
  assert.deepEqual(transportCalls("binding-aliases.ts", `
    const computed = env["STORE"];
    const { QUEUE: queue } = env;
    let assigned;
    assigned = env.LATER;
    class Holder {
      run() {
        const { QUEUE: nestedQueue } = this.env;
        const stub = this.service.get("id");
        this.service.call();
        nestedQueue.call();
        stub.call();
      }
      service = this.env.SERVICE;
    }
    function late() {
      const lateStub = lateService.get("id");
      lateStub.call();
    }
    const lateService = env.LATE_SERVICE;
    computed.get();
    queue.call();
    assigned.call();
  `), [
    "service-binding:<module>:assigned.call",
    "service-binding:<module>:computed.get",
    "service-binding:<module>:queue.call",
    "service-binding:late:lateService.get",
    "service-binding:late:lateStub.call",
    "service-binding:run:nestedQueue.call",
    "service-binding:run:stub.call",
    "service-binding:run:this.service.call",
    "service-binding:run:this.service.get",
  ]);
});

test("direct Gatekeeper transport call sites stay on an explicit allowlist", () => {
  const packageNames = readdirSync(PACKAGES)
      .filter(name => name.startsWith("gatekeeper-") || name === "mcp-shared");
  const actual = {};
  for (const packageName of packageNames) {
    for (const path of sourceFiles(join(PACKAGES, packageName, "src"))) {
      const sites = transportCalls(path);
      if (sites.length > 0) {
        actual[relative(ROOT, path)] = sites;
      }
    }
  }

  const expected = JSON.parse(readFileSync(ALLOWLIST, "utf8"));
  assert.deepEqual(Object.keys(expected).toSorted(), Object.keys(actual).toSorted(),
      `transport allowlist paths changed; actual inventory:\n${JSON.stringify(actual, null, 2)}`);
  for (const [path, entry] of Object.entries(expected)) {
    assert.equal(typeof entry.reason, "string");
    assert.ok(entry.reason.trim().length >= 20, `${path} needs a specific allowlist reason`);
    assert.deepEqual(entry.sites, actual[path],
        `${path} transport calls changed; review billing/control placement before updating`);
  }
});
