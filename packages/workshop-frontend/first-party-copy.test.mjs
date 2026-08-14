import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// TypeScript 7 uses the native compiler and does not expose the JavaScript compiler API used by
// this source scanner. The root keeps TypeScript 6 under this alias for build-time tooling.
import ts from 'typescript6'
import { describe, expect, it } from 'vitest'

const sourceRoot = fileURLToPath(new URL('./src/', import.meta.url))
const entrypoints = [
  join(sourceRoot, 'main.tsx'),
  join(sourceRoot, 'marketing-prerender.tsx'),
]
const visibleAttributes = new Set([
  'alt',
  'aria-description',
  'aria-label',
  'content',
  'description',
  'emptyText',
  'heading',
  'helpText',
  'label',
  'message',
  'placeholder',
  'subtitle',
  'text',
  'title',
  'tooltip',
])
const codeElements = new Set(['code', 'kbd', 'pre', 'script', 'style'])
const objectCopyProperties = new Set(visibleAttributes)
const copyVariableName = /(?:copy|description|heading|help|label|message|placeholder|subtitle|text|title|tooltip)/i

function resolveSourceImport(from, specifier) {
  if (!specifier.startsWith('.')) return null

  const base = resolve(dirname(from), specifier)
  const extensionless = base.replace(/\.js$/, '')
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${extensionless}.ts`,
    `${extensionless}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ]
  return candidates.find(candidate => (
    existsSync(candidate) && statSync(candidate).isFile()
  )) ?? null
}

function reachableSourceFiles() {
  const files = new Set()

  const visit = (file) => {
    if (files.has(file)) return
    files.add(file)

    const source = readFileSync(file, 'utf8')
    for (const imported of ts.preProcessFile(source, true, true).importedFiles) {
      const resolved = resolveSourceImport(file, imported.fileName)
      if (resolved?.startsWith(sourceRoot)) visit(resolved)
    }
  }

  entrypoints.forEach(visit)
  return [...files]
    .filter(file => file.endsWith('.ts') || file.endsWith('.tsx'))
    .toSorted()
}

function staticStrings(expression) {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return [expression.text]
  }
  if (ts.isTemplateExpression(expression)) {
    return [
      expression.head.text,
      ...expression.templateSpans.map(span => span.literal.text),
    ]
  }
  if (ts.isConditionalExpression(expression)) {
    return [
      ...staticStrings(expression.whenTrue),
      ...staticStrings(expression.whenFalse),
    ]
  }
  if (ts.isBinaryExpression(expression)) {
    if (
      expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      || expression.operatorToken.kind === ts.SyntaxKind.BarBarToken
      || expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    ) {
      return staticStrings(expression.right)
    }
    if (expression.operatorToken.kind !== ts.SyntaxKind.PlusToken) return []
    return [
      ...staticStrings(expression.left),
      ...staticStrings(expression.right),
    ]
  }
  if (ts.isParenthesizedExpression(expression)) {
    return staticStrings(expression.expression)
  }
  return []
}

function parentElementName(node, sourceFile) {
  if (ts.isJsxElement(node.parent)) {
    return node.parent.openingElement.tagName.getText(sourceFile)
  }
  return null
}

function isRateLimiterDiagnosticLabel(node, sourceFile) {
  return node.name.getText(sourceFile) === 'label'
    && ts.isObjectLiteralExpression(node.parent)
    && ts.isCallExpression(node.parent.parent)
    && ts.isIdentifier(node.parent.parent.expression)
    && node.parent.parent.expression.text === 'createRateLimitedCapability'
}

function findHardcodedCopy(file) {
  const scriptKind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sourceFile = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  )
  const findings = []

  const record = (node, value) => {
    const normalized = value.trim().replace(/\s+/g, ' ')
    if (!/[A-Za-z]{2}/.test(normalized)) return
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1
    findings.push(`${file}:${line} ${normalized}`)
  }

  const visit = (node) => {
    if (ts.isJsxText(node)) {
      const element = parentElementName(node, sourceFile)
      if (!element || !codeElements.has(element)) record(node, node.text)
    }

    if (ts.isJsxExpression(node) && node.expression && !ts.isJsxAttribute(node.parent)) {
      const element = parentElementName(node, sourceFile)
      if (!element || !codeElements.has(element)) {
        staticStrings(node.expression).forEach(value => record(node, value))
      }
    }

    if (ts.isJsxAttribute(node) && visibleAttributes.has(node.name.getText(sourceFile))) {
      const initializer = node.initializer
      const values = initializer && ts.isJsxExpression(initializer)
        ? initializer.expression ? staticStrings(initializer.expression) : []
        : initializer ? staticStrings(initializer) : []
      values
        .filter(value => !/^(?:https?:\/\/|[\w-]+\.[a-z0-9]+$)/i.test(value))
        .forEach(value => record(node, value))
    }

    if (
      ts.isPropertyAssignment(node)
      && objectCopyProperties.has(node.name.getText(sourceFile))
      && !isRateLimiterDiagnosticLabel(node, sourceFile)
    ) {
      staticStrings(node.initializer).forEach(value => record(node, value))
    }

    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && copyVariableName.test(node.name.text)
      && !/(?:Class|Cls|Id)$/.test(node.name.text)
      && node.initializer
    ) {
      staticStrings(node.initializer).forEach(value => record(node, value))
    }

    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && ['alert', 'confirm', 'prompt'].includes(node.expression.text)
    ) {
      node.arguments.flatMap(staticStrings).forEach(value => record(node, value))
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return findings
}

describe('first-party localization contract', () => {
  it('keeps raw English copy out of reachable first-party JSX', () => {
    const findings = reachableSourceFiles().flatMap(findHardcodedCopy)

    expect(findings).toEqual([])
  })
})
