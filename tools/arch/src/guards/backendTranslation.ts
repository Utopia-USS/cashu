// Backend requests/runs carry an immutable Translator. Only explicit pure i18n imports are safe;
// ambient getters and UI catalogs would leak language across concurrent work.
import ts from "typescript";

/** Production backend files; renderer/UI packages and test-only code retain their own language API. */
export function isBackendTranslationFile(path: string): boolean {
  const file = path.replaceAll("\\", "/");
  if (!/\.[cm]?[jt]sx?$/.test(file)) return false;
  if (/(\.(test|spec|stories)\.[cm]?[jt]sx?$|\/(testing|test-fixtures|e2e)\/)/.test(file))
    return false;
  return (
    /^packages\/(api|mcp|store|sync|market)\/src\//.test(file) ||
    /^apps\/(cli|relay|sync-daemon)\/src\//.test(file) ||
    /^apps\/desktop\/src\/(?!renderer(?:\/|$))/.test(file)
  );
}

function i18nEntry(node: ts.Node | undefined): "root" | "subpath" | null {
  if (!node || !ts.isStringLiteralLike(node)) return null;
  if (node.text === "@cashu/i18n") return "root";
  return node.text.startsWith("@cashu/i18n/") ? "subpath" : null;
}

// New runtime exports require a deliberate review before backend use. Type-only imports are erased.
const BACKEND_SAFE = new Set([
  "createTranslator",
  "createBackendI18n",
  "parseLang",
  "LANG_ENV",
  "LANG_HEADER",
  "LANGS",
  "FALLBACK_LANG",
  "matchLang",
  "plCount",
  "plForm",
  "enCount",
  "enForm",
  "normalizeNumberInput",
]);

function importsAmbient(elements: readonly (ts.ImportSpecifier | ts.ExportSpecifier)[]): boolean {
  return elements.some(
    (element) =>
      !element.isTypeOnly && !BACKEND_SAFE.has((element.propertyName ?? element.name).text),
  );
}

/** Lines exposing ambient language to backend code. Parse syntax, not text: comments, strings, aliases,
 * multiline imports and type-only references must be handled correctly. Namespace/dynamic/CommonJS
 * access and UI catalog subpaths are disallowed; use named imports of reviewed pure root helpers. */
export function ambientTranslationLines(source: string, fileName = "backend.ts"): number[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const lines = new Set<number>();
  const flag = (node: ts.Node) =>
    lines.add(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && i18nEntry(node.moduleSpecifier)) {
      const clause = node.importClause;
      if (!clause) flag(node);
      else if (!clause.isTypeOnly) {
        const bindings = clause.namedBindings;
        if (
          i18nEntry(node.moduleSpecifier) === "subpath" ||
          clause.name ||
          (bindings && (ts.isNamespaceImport(bindings) || importsAmbient(bindings.elements)))
        )
          flag(node);
      }
    } else if (
      ts.isExportDeclaration(node) &&
      !node.isTypeOnly &&
      i18nEntry(node.moduleSpecifier)
    ) {
      if (
        i18nEntry(node.moduleSpecifier) === "subpath" ||
        !node.exportClause ||
        !ts.isNamedExports(node.exportClause) ||
        importsAmbient(node.exportClause.elements)
      )
        flag(node);
    } else if (ts.isCallExpression(node) && i18nEntry(node.arguments[0])) {
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")
      )
        flag(node);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference) &&
      i18nEntry(node.moduleReference.expression)
    ) {
      flag(node);
    }
    ts.forEachChild(node, visit);
  }

  visit(file);
  return [...lines].sort((a, b) => a - b);
}
