import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript6";
import { findDeployablePackages, readWranglerConfig } from "./release/manifest-lib.mjs";

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPTS, "..");
const PACKAGES = join(ROOT, "packages");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function unwrapExpression(expression) {
  while (ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)) {
    expression = expression.expression;
  }
  return expression;
}

function publicInterfaceMethods(path) {
  const source = ts.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
  );
  const methods = [];
  const visit = (node) => {
    if (ts.isInterfaceDeclaration(node)) {
      for (const base of node.heritageClauses ?? []) {
        for (const type of base.types) {
          if (type.expression.getText(source) !== "RpcTarget") {
            methods.push(`${node.name.text}.<inherits:${type.expression.getText(source)}>`);
          }
        }
      }
      for (const member of node.members) {
        if (ts.isMethodSignature(member) ||
            ts.isPropertySignature(member) && member.type && ts.isFunctionTypeNode(member.type)) {
          methods.push(`${node.name.text}.${member.name.getText(source)}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return methods;
}

function billingRegistryMethodKeys(path) {
  const source = ts.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
  );
  const methodKeys = [];
  const localRegistries = new Set();
  const collectRegistries = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
        node.name.text.endsWith("_BILLING_METHODS")) {
      localRegistries.add(node.name.text);
    }
    ts.forEachChild(node, collectRegistries);
  };
  collectRegistries(source);
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text.endsWith("_BILLING_METHODS") &&
        node.initializer !== undefined) {
      const initializer = unwrapExpression(node.initializer);
      assert.ok(ts.isObjectLiteralExpression(initializer),
          `${node.name.text} must be an object-literal billing registry`);
      for (const property of initializer.properties) {
        if (ts.isSpreadAssignment(property)) {
          assert.ok(ts.isIdentifier(property.expression) &&
              localRegistries.has(property.expression.text),
          `${node.name.text} cannot spread an imported or computed billing registry`);
          continue;
        }
        assert.ok(ts.isPropertyAssignment(property),
            `${node.name.text} entries must be property assignments`);
        const value = unwrapExpression(property.initializer);
        if (ts.isCallExpression(value) &&
            value.arguments.length === 1 &&
            ts.isStringLiteral(value.arguments[0])) {
          methodKeys.push(value.arguments[0].text);
          continue;
        }
        if (ts.isObjectLiteralExpression(value)) {
          const methodKey = value.properties.find(entry =>
            ts.isPropertyAssignment(entry) && entry.name.getText(source) === "methodKey");
          assert.ok(methodKey && ts.isPropertyAssignment(methodKey) &&
              ts.isStringLiteral(methodKey.initializer),
          `${node.name.text} has an entry without a literal methodKey`);
          methodKeys.push(methodKey.initializer.text);
          continue;
        }
        assert.fail(`${node.name.text} has an unsupported billing entry`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return methodKeys;
}

function registrySurfaceNames(path, suffix) {
  const source = ts.createSourceFile(
      path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = new Set();
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
        node.name.text.endsWith(suffix) && node.initializer !== undefined) {
      const initializer = unwrapExpression(node.initializer);
      assert.ok(ts.isObjectLiteralExpression(initializer),
          `${node.name.text} must be an object-literal registry`);
      for (const property of initializer.properties) {
        if (ts.isSpreadAssignment(property)) continue;
        assert.ok(ts.isPropertyAssignment(property),
            `${node.name.text} entries must be property assignments`);
        names.add(ts.isStringLiteral(property.name)
          ? property.name.text : property.name.getText(source));
        if (suffix === "_CONTROL_METHODS") {
          const value = unwrapExpression(property.initializer);
          assert.ok(ts.isObjectLiteralExpression(value),
              `${node.name.text} control entries must be object literals`);
          const reason = value.properties.find(entry => ts.isPropertyAssignment(entry) &&
            entry.name.getText(source) === "reason");
          assert.ok(reason && ts.isPropertyAssignment(reason) &&
              ts.isStringLiteral(reason.initializer) && reason.initializer.text.length >= 20,
          `${node.name.text} control entries need a specific literal reason`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

function sourceTypeScriptFiles(path) {
  const files = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...sourceTypeScriptFiles(child));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) files.push(child);
  }
  return files;
}

function supplementalSurfaceNames(paths) {
  const names = new Set();
  for (const path of paths) {
    const source = ts.createSourceFile(
        path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node) => {
      if (ts.isClassDeclaration(node) && node.name) {
        const isSlashProvider = node.heritageClauses?.some(clause =>
          clause.token === ts.SyntaxKind.ImplementsKeyword &&
          clause.types.some(type => type.expression.getText(source) === "SlashCommandProvider"));
        for (const member of node.members) {
          if (!ts.isMethodDeclaration(member)) continue;
          const method = member.name.getText(source);
          if (method === "getAgentCatalog" || method === "getSlashCommandProvider" ||
              isSlashProvider && (method === "list" || method === "invoke")) {
            names.add(`${node.name.text}.${method}`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return names;
}

function runtimeApiSurfaceNames(paths) {
  const names = new Set();
  for (const path of paths) {
    const source = ts.createSourceFile(
        path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node) => {
      if (ts.isClassDeclaration(node) && node.name) {
        let surface;
        for (const clause of node.heritageClauses ?? []) {
          if (clause.token !== ts.SyntaxKind.ImplementsKeyword) continue;
          for (const type of clause.types) {
            const contract = type.expression.getText(source);
            if (node.name.text === `${contract}Impl` && contract.endsWith("Api")) {
              surface = contract;
            } else if (contract === `${node.name.text}Contract` &&
                node.name.text.endsWith("Api")) {
              surface = node.name.text;
            }
          }
        }
        if (surface) {
          for (const member of node.members) {
            if (!ts.isMethodDeclaration(member) ||
                member.name.getText(source) === "[Symbol.dispose]") continue;
            const modifiers = ts.getModifiers(member) ?? [];
            if (modifiers.some(modifier => [
              ts.SyntaxKind.PrivateKeyword,
              ts.SyntaxKind.ProtectedKeyword,
              ts.SyntaxKind.StaticKeyword,
            ].includes(modifier.kind)) || ts.isPrivateIdentifier(member.name)) continue;
            assert.ok(ts.isIdentifier(member.name),
                `${path} has an unsupported computed public method on ${node.name.text}`);
            names.add(`${surface}.${member.name.text}`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return names;
}

function declaresEmptySupportedResources(path) {
  const source = ts.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
  );
  let found = false;
  const visit = (node) => {
    if (ts.isMethodDeclaration(node) &&
        node.name?.getText(source) === "getSupportedResources" &&
        node.body?.statements.length === 1) {
      const statement = node.body.statements[0];
      found = ts.isReturnStatement(statement) &&
        statement.expression !== undefined &&
        ts.isArrayLiteralExpression(statement.expression) &&
        statement.expression.elements.length === 0;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function usesDynamicMcpFacet(path, facetName) {
  const source = ts.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
  );
  let importsFacet = false;
  const facetClasses = [];
  const visit = (node) => {
    if (ts.isImportDeclaration(node) &&
        node.moduleSpecifier.getText(source) === '"@gadgets/mcp-shared/facet"') {
      importsFacet = node.importClause?.namedBindings !== undefined &&
        ts.isNamedImports(node.importClause.namedBindings) &&
        node.importClause.namedBindings.elements.some(element => element.name.text === facetName);
    }
    if (ts.isClassDeclaration(node) && node.name &&
        node.heritageClauses?.some(clause =>
        clause.token === ts.SyntaxKind.ExtendsKeyword &&
        clause.types.some(type => type.expression.getText(source) === facetName)) === true) {
      facetClasses.push(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return importsFacet ? facetClasses : [];
}

function callsFunction(path, functionName) {
  const source = ts.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
  );
  let found = false;
  const visit = (node) => {
    if (ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) && node.expression.text === functionName) {
      found = true;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

test("every deployable Gatekeeper declares one billing contract", async (t) => {
  const gatekeepers = findDeployablePackages(PACKAGES)
      .filter(({ name }) => name.startsWith("gatekeeper-"));
  assert.ok(gatekeepers.length > 0, "no deployable Gatekeeper packages discovered");

  for (const pkg of gatekeepers) {
    await t.test(pkg.name, () => {
      const manifest = readJson(join(pkg.dir, "package.json"));
      assert.equal(typeof manifest.scripts?.build, "string", "missing build script");
      assert.equal(typeof manifest.scripts?.test, "string", "missing test script");

      const registryPath = join(pkg.dir, "src", "billing-methods.ts");
      const registryTestPath = join(pkg.dir, "__tests__", "billing-methods.test.ts");
      const hasRegistry = existsSync(registryPath);
      const hasRegistryTest = existsSync(registryTestPath);
      assert.equal(hasRegistry, hasRegistryTest,
          "a static billing registry and its contract test must be added together");

      const hasDynamicMcpRegistry = manifest.gatekeeperBilling?.kind === "dynamic-mcp";
      if (hasDynamicMcpRegistry) {
        assert.equal(manifest.dependencies?.["@gadgets/mcp-shared"], "workspace:*",
            "dynamic MCP contract must use the shared workspace implementation");
        assert.equal(typeof manifest.gatekeeperBilling.facet, "string",
            "dynamic MCP contract must name its billing facet");
        const facetClasses = usesDynamicMcpFacet(
            join(pkg.dir, manifest.main), manifest.gatekeeperBilling.facet);
        const wrangler = readWranglerConfig(pkg.dir);
        const configuredClasses = [
          ...(wrangler.durable_objects?.bindings?.map(binding => binding.class_name) ?? []),
          ...(wrangler.migrations?.flatMap(migration => migration.new_sqlite_classes ?? []) ?? []),
        ];
        assert.ok(facetClasses.some(className => configuredClasses.includes(className)),
            "a configured dynamic MCP Durable Object must extend the shared billing facet");
      }
      const staticMethodKeys = hasRegistry ? billingRegistryMethodKeys(registryPath) : [];
      const hasStaticBusinessRegistry = staticMethodKeys.length > 0;
      const hasExplicitZeroSurface = hasRegistry && !hasStaticBusinessRegistry;
      if (hasExplicitZeroSurface) {
        const typesPath = join(pkg.dir, "src", "types.d.ts");
        assert.ok(existsSync(typesPath),
            "an explicit zero billing surface must include its public TypeScript declarations");
        assert.deepEqual(publicInterfaceMethods(typesPath), [],
            "an explicit zero billing surface cannot expose public Session methods");
        const mainPath = join(pkg.dir, "src", `${pkg.name.slice("gatekeeper-".length)}.ts`);
        assert.ok(existsSync(mainPath) && declaresEmptySupportedResources(mainPath),
            "an explicit zero billing surface must return no supported resources");
      }

      assert.equal(
          [hasStaticBusinessRegistry, hasDynamicMcpRegistry, hasExplicitZeroSurface]
              .filter(Boolean).length,
          1,
          "Gatekeeper must use exactly one billing-contract form",
      );

      if (hasRegistry) {
        if (hasStaticBusinessRegistry) {
          assert.ok(callsFunction(registryTestPath, "testPublicBillingSurface"),
              "a typed static Gatekeeper must run the shared AST surface contract");
        }
        assert.equal(new Set(staticMethodKeys).size, staticMethodKeys.length,
            "static billing method keys must be unique across the Gatekeeper");
        for (const methodKey of staticMethodKeys) {
          assert.match(methodKey, /^[A-Za-z0-9@][A-Za-z0-9._:/@-]{0,199}$/,
              "static billing method key must be a stable usage dimension");
        }
        const sourcePaths = sourceTypeScriptFiles(join(pkg.dir, "src"));
        const supplementalMethods = supplementalSurfaceNames(sourcePaths);
        const runtimeApiMethods = runtimeApiSurfaceNames(sourcePaths);
        const billedSurfaces = registrySurfaceNames(registryPath, "_BILLING_METHODS");
        const controlSurfaces = registrySurfaceNames(registryPath, "_CONTROL_METHODS");
        const supplementalSurfaces = new Set([...supplementalMethods]
            .map(name => name.slice(0, name.indexOf("."))));
        const classifiedSupplemental = new Set([...billedSurfaces, ...controlSurfaces]
            .filter(name => supplementalSurfaces.has(name.slice(0, name.indexOf(".")))));
        assert.deepEqual(
            [...classifiedSupplemental].toSorted(), [...supplementalMethods].toSorted(),
            "every Gatekeeper catalog and slash surface must have one billing classification");
        for (const method of supplementalMethods) {
          assert.equal(Number(billedSurfaces.has(method)) + Number(controlSurfaces.has(method)), 1,
              `${method} must have exactly one billing or control classification`);
        }
        const runtimeApiSurfaces = new Set([...runtimeApiMethods]
            .map(name => name.slice(0, name.indexOf("."))));
        const classifiedRuntimeApi = new Set([...billedSurfaces, ...controlSurfaces]
            .filter(name => runtimeApiSurfaces.has(name.slice(0, name.indexOf(".")))));
        assert.deepEqual([...classifiedRuntimeApi].toSorted(), [...runtimeApiMethods].toSorted(),
            "real management RPC classes must exactly match their billing classifications");
        for (const method of runtimeApiMethods) {
          assert.equal(Number(billedSurfaces.has(method)) + Number(controlSurfaces.has(method)), 1,
              `${method} must have exactly one billing or control classification`);
        }
      }
      if (hasDynamicMcpRegistry) {
        assert.ok(existsSync(join(PACKAGES, "mcp-shared", "__tests__", "billing.test.ts")),
            "dynamic MCP billing contract test is missing");
        assert.ok(existsSync(join(PACKAGES, "mcp-shared", "__tests__", "session-methods-e2e.test.ts")),
            "dynamic MCP Session contract test is missing");
      }
    });
  }
});
