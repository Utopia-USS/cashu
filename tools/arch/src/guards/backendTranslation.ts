// Backend requests/runs carry an immutable Translator. The root UI tr() reads global language,
// so importing it (including via a module namespace) would leak language across concurrent work.
import ts from "typescript";

/** Production backend files; renderer/UI packages and test-only code retain their own language API. */
export function isBackendTranslationFile(path: string): boolean {
  const file = path.replaceAll("\\", "/");
  if (!/\.[cm]?[jt]sx?$/.test(file)) return false;
  if (/(\.(test|spec|stories)\.[cm]?[jt]sx?$|\/(testing|test-fixtures|e2e)\/)/.test(file))
    return false;
  return (
    /^packages\/(api|mcp|store|sync|market)\/src\//.test(file) ||
    /^apps\/(cli|sync-daemon)\/src\//.test(file) ||
    /^apps\/desktop\/src\/(?!renderer(?:\/|$))/.test(file)
  );
}

function isI18n(node: ts.Node | undefined): boolean {
  return node !== undefined && ts.isStringLiteralLike(node) && node.text === "@cashu/i18n";
}

function importsTr(elements: readonly (ts.ImportSpecifier | ts.ExportSpecifier)[]): boolean {
  return elements.some(
    (element) => !element.isTypeOnly && (element.propertyName ?? element.name).text === "tr",
  );
}

/** Lines exposing ambient UI tr to backend code. Parse syntax, not text: comments, strings, aliases,
 * multiline imports and type-only references must be handled correctly. Namespace/dynamic/CommonJS
 * root imports are disallowed because they expose tr; use explicit named imports for pure helpers. */
export function ambientTranslationLines(source: string, fileName = "backend.ts"): number[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const lines = new Set<number>();
  const flag = (node: ts.Node) =>
    lines.add(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && isI18n(node.moduleSpecifier)) {
      const clause = node.importClause;
      if (clause && !clause.isTypeOnly) {
        const bindings = clause.namedBindings;
        if (
          clause.name ||
          (bindings && (ts.isNamespaceImport(bindings) || importsTr(bindings.elements)))
        )
          flag(node);
      }
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && isI18n(node.moduleSpecifier)) {
      if (
        !node.exportClause ||
        !ts.isNamedExports(node.exportClause) ||
        importsTr(node.exportClause.elements)
      )
        flag(node);
    } else if (ts.isCallExpression(node) && isI18n(node.arguments[0])) {
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")
      )
        flag(node);
    }
    ts.forEachChild(node, visit);
  }

  visit(file);
  return [...lines].sort((a, b) => a - b);
}
