// The UI action catalog (packages/store/src/ui-action-catalog.ts) lists every UiAction a client can
// dispatch; apps/host productionActions.test.ts checks that the production host registers each one.
// This guard keeps the catalog complete: every `UiAction` constant the store declares and every
// `useUiAction(x)` argument of the desktop renderer must be a catalog entry. Parse syntax, not text.
import ts from "typescript";

export const CATALOG_FILE = "packages/store/src/ui-action-catalog.ts";

function parse(source: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
}

function lineOf(file: ts.SourceFile, node: ts.Node): number {
  return file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
}

/** The identifiers in the catalog's `UI_ACTIONS` array literal. */
export function catalogNames(source: string): string[] {
  const file = parse(source, CATALOG_FILE);
  const names: string[] = [];
  file.forEachChild(function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "UI_ACTIONS" &&
      node.initializer !== undefined &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      for (const element of node.initializer.elements)
        names.push(ts.isIdentifier(element) ? element.text : `<${element.getText(file)}>`);
      return;
    }
    node.forEachChild(visit);
  });
  return names;
}

/** Exported constants whose declared type is `UiAction<...>` (the store's action declarations). */
export function declaredUiActions(source: string, fileName = "store.ts"): string[] {
  const file = parse(source, fileName);
  const names: string[] = [];
  file.forEachChild(function visit(node) {
    if (
      ts.isVariableStatement(node) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      for (const declaration of node.declarationList.declarations) {
        const type = declaration.type;
        if (
          ts.isIdentifier(declaration.name) &&
          type !== undefined &&
          ts.isTypeReferenceNode(type) &&
          ts.isIdentifier(type.typeName) &&
          type.typeName.text === "UiAction"
        )
          names.push(declaration.name.text);
      }
      return;
    }
    node.forEachChild(visit);
  });
  return names;
}

export interface UiActionUse {
  readonly line: number;
  /** The imported name of the action constant, or null when the argument is not an imported one. */
  readonly name: string | null;
  readonly from: string | null;
}

/** Every `useUiAction(x)` call: `x` must be a named import (the action constant, typed). */
export function uiActionUses(source: string, fileName = "renderer.tsx"): UiActionUse[] {
  const file = parse(source, fileName);
  const imports = new Map<string, { name: string; from: string }>();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements)
      imports.set(element.name.text, {
        name: (element.propertyName ?? element.name).text,
        from: statement.moduleSpecifier.text,
      });
  }
  const uses: UiActionUse[] = [];
  file.forEachChild(function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "useUiAction"
    ) {
      const arg = node.arguments[0];
      const imported =
        arg !== undefined && ts.isIdentifier(arg) ? imports.get(arg.text) : undefined;
      uses.push({
        line: lineOf(file, node),
        name: imported?.name ?? null,
        from: imported?.from ?? null,
      });
    }
    node.forEachChild(visit);
  });
  return uses;
}
