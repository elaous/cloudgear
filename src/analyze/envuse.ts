import { Node, SyntaxKind, type SourceFile } from "ts-morph";

export interface EnvVarUse {
  // Read without a fallback or a presence check, so the code expects it to be set.
  required: boolean;
  // Files that read it, from the project root.
  files: string[];
}

export interface EnvUse {
  variables: Record<string, EnvVarUse>;
  // Places that read the environment in a way that cannot be listed (a computed name, a spread).
  dynamic: string[];
}

const ASSIGNMENTS = new Set([SyntaxKind.EqualsToken, SyntaxKind.QuestionQuestionEqualsToken, SyntaxKind.BarBarEqualsToken, SyntaxKind.AmpersandAmpersandEqualsToken]);
const OPTIONAL_OPERATORS = new Set([SyntaxKind.QuestionQuestionToken, SyntaxKind.BarBarToken, SyntaxKind.AmpersandAmpersandToken, SyntaxKind.EqualsEqualsToken, SyntaxKind.EqualsEqualsEqualsToken, SyntaxKind.ExclamationEqualsToken, SyntaxKind.ExclamationEqualsEqualsToken]);

// Strips parentheses and casts: `(process.env as any).X`, `process.env.X!`.
const outer = (node: Node): Node => {
  let current = node;
  for (;;) {
    const parent = current.getParent();
    if (parent && (Node.isParenthesizedExpression(parent) || Node.isAsExpression(parent) || Node.isNonNullExpression(parent) || Node.isTypeAssertion(parent) || Node.isSatisfiesExpression(parent))) current = parent;
    else return current;
  }
};

const inner = (node: Node): Node => {
  let current = node;
  while (Node.isParenthesizedExpression(current) || Node.isAsExpression(current) || Node.isNonNullExpression(current) || Node.isTypeAssertion(current) || Node.isSatisfiesExpression(current)) current = current.getExpression();
  return current;
};

// `process.env`, `Bun.env`, `globalThis.process.env` and `import.meta.env`.
function isEnvAccess(node: Node): boolean {
  if (!Node.isPropertyAccessExpression(node) || node.getName() !== "env") return false;
  const owner = inner(node.getExpression());
  if (Node.isMetaProperty(owner)) return true;
  if (Node.isIdentifier(owner)) return owner.getText() === "process" || owner.getText() === "Bun";
  return Node.isPropertyAccessExpression(owner) && owner.getExpression().getText() === "globalThis" && (owner.getName() === "process" || owner.getName() === "Bun");
}

const isGuardBranch = (statement: Node): boolean =>
  statement.getKind() === SyntaxKind.ThrowStatement ||
  statement.getDescendantsOfKind(SyntaxKind.ThrowStatement).length > 0 ||
  statement.getDescendantsOfKind(SyntaxKind.CallExpression).some((call) => /^(process|Bun|Deno)\.exit$/.test(call.getExpression().getText()));

// A read the code survives the variable being unset: a fallback, a comparison or a presence check.
// A check whose failure throws or exits is the opposite: the code requires the variable.
function isOptionalRead(read: Node): boolean {
  const at = outer(read);
  for (const ancestor of at.getAncestors()) {
    if (Node.isFunctionLikeDeclaration(ancestor) || Node.isSourceFile(ancestor)) break;
    if (Node.isIfStatement(ancestor) && ancestor.getExpression().containsRange(at.getPos(), at.getEnd())) return !isGuardBranch(ancestor.getThenStatement());
  }
  const parent = at.getParent();
  if (!parent) return false;
  if (Node.isBinaryExpression(parent)) {
    const operator = parent.getOperatorToken().getKind();
    if (ASSIGNMENTS.has(operator)) return parent.getLeft() === at;
    return OPTIONAL_OPERATORS.has(operator) && (parent.getLeft() === at || operator !== SyntaxKind.QuestionQuestionToken && operator !== SyntaxKind.BarBarToken && operator !== SyntaxKind.AmpersandAmpersandToken);
  }
  if (Node.isPrefixUnaryExpression(parent)) return parent.getOperatorToken() === SyntaxKind.ExclamationToken;
  if (Node.isTypeOfExpression(parent)) return true;
  if (Node.isConditionalExpression(parent)) return parent.getCondition() === at;
  if (Node.isPropertyAccessExpression(parent) && parent.getExpression() === at) return parent.hasQuestionDotToken();
  if (Node.isElementAccessExpression(parent) && parent.getExpression() === at) return parent.hasQuestionDotToken();
  if (Node.isCallExpression(parent) && parent.getArguments().includes(at as never)) return parent.getExpression().getText() === "Boolean";
  return false;
}

// Not a read at all: the code sets the variable, or removes it.
function isWrite(read: Node): boolean {
  const at = outer(read);
  const parent = at.getParent();
  if (Node.isDeleteExpression(parent)) return true;
  return Node.isBinaryExpression(parent) && parent.getLeft() === at && parent.getOperatorToken().getKind() === SyntaxKind.EqualsToken;
}

const OBJECT_METHODS = new Set(["hasOwnProperty", "toString", "valueOf", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString"]);

// What the project's own code reads from the environment. It follows the code the function runs: its
// body, what that calls, and the top-level code of every project file it imports (which runs on load),
// not the other functions that merely share a file. `node_modules` and dynamic imports are not followed.
export function scanEnvUse(fnNode: Node, isAppFile: (file: SourceFile) => boolean, relative: (file: string) => string): EnvUse {
  const variables = new Map<string, { required: boolean; files: Set<string> }>();
  const dynamic: string[] = [];
  const files = new Set<SourceFile>();
  const regions = new Set<Node>();
  const queue: Node[] = [];
  const aliases = new Set<Node>();

  const note = (name: string, required: boolean, file: string) => {
    const earlier = variables.get(name) ?? { required: false, files: new Set<string>() };
    earlier.required ||= required;
    earlier.files.add(file);
    variables.set(name, earlier);
  };

  const declarationsOf = (identifier: Node): Node[] => {
    const symbol = identifier.getSymbol();
    const resolved = symbol?.isAlias() ? symbol.getAliasedSymbol() : symbol;
    return resolved?.getDeclarations() ?? [];
  };

  const addRegion = (node: Node) => {
    if (regions.has(node)) return;
    regions.add(node);
    queue.push(node);
  };

  const isDeclarationOnly = (statement: Node): boolean => {
    if (Node.isFunctionDeclaration(statement) || Node.isClassDeclaration(statement) || Node.isInterfaceDeclaration(statement) || Node.isTypeAliasDeclaration(statement) || Node.isEnumDeclaration(statement)) return true;
    if (Node.isImportDeclaration(statement) || Node.isExportDeclaration(statement) || Node.isModuleDeclaration(statement)) return true;
    if (Node.isVariableStatement(statement)) return statement.getDeclarations().every((d) => { const init = d.getInitializer(); return !!init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init)); });
    return false;
  };

  const addFile = (file: SourceFile | undefined) => {
    if (!file || files.has(file) || !isAppFile(file)) return;
    files.add(file);
    for (const decl of file.getImportDeclarations()) {
      const valueImport = !decl.isTypeOnly() && (decl.getNamedImports().length === 0 || decl.getNamedImports().some((n) => !n.isTypeOnly()));
      if (valueImport) addFile(decl.getModuleSpecifierSourceFile());
    }
    for (const decl of file.getExportDeclarations()) if (!decl.isTypeOnly()) addFile(decl.getModuleSpecifierSourceFile());
    for (const declaration of file.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
      const init = declaration.getInitializer();
      if (init && isEnvAccess(inner(init)) && Node.isIdentifier(declaration.getNameNode())) aliases.add(declaration);
    }
    for (const statement of file.getStatements()) {
      // The router declaration only names the functions; it does not run their code.
      if (isDeclarationOnly(statement) || statement.getDescendantsOfKind(SyntaxKind.NewExpression).some((e) => e.getExpression().getText() === "FunctionRouter")) continue;
      addRegion(statement);
    }
  };

  const isEnvObject = (node: Node): boolean => {
    if (isEnvAccess(node)) return true;
    if (!Node.isIdentifier(node)) return false;
    return declarationsOf(node).some((d) => aliases.has(d));
  };

  const scan = (region: Node) => {
    const file = region.getSourceFile();
    const rel = relative(file.getFilePath());
    const at = (node: Node) => `${rel}:${node.getStartLineNumber()}`;
    const nodes = [region, ...region.getDescendants()];
    for (const node of nodes) {
      if (Node.isIdentifier(node) && node !== region) {
        for (const decl of declarationsOf(node)) {
          if (!isAppFile(decl.getSourceFile())) continue;
          if (Node.isFunctionDeclaration(decl) || Node.isMethodDeclaration(decl) || Node.isClassDeclaration(decl) || Node.isVariableDeclaration(decl)) {
            addFile(decl.getSourceFile());
            addRegion(decl);
          }
        }
      }
      if (!isEnvObject(node)) continue;
      const declaredHere = node.getParent();
      if (Node.isVariableDeclaration(declaredHere) && declaredHere.getNameNode() === node) continue;
      const top = outer(node);
      const parent = top.getParent();
      if (Node.isVariableDeclaration(parent) && Node.isIdentifier(parent.getNameNode()) && parent.getInitializer() === top) continue;
      if (Node.isPropertyAccessExpression(parent) && parent.getExpression() === top) {
        const call = outer(parent).getParent();
        if (OBJECT_METHODS.has(parent.getName()) && Node.isCallExpression(call) && call.getExpression() === outer(parent)) continue;
        if (!isWrite(parent)) note(parent.getName(), !isOptionalRead(parent), rel);
      } else if (Node.isElementAccessExpression(parent) && parent.getExpression() === top) {
        const arg = parent.getArgumentExpression();
        if (arg && (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg))) {
          if (!isWrite(parent)) note(arg.getLiteralValue(), !isOptionalRead(parent), rel);
        } else dynamic.push(at(parent));
      } else if (Node.isVariableDeclaration(parent) && Node.isObjectBindingPattern(parent.getNameNode()) && parent.getInitializer() === top) {
        const pattern = parent.getNameNode();
        if (Node.isObjectBindingPattern(pattern)) {
          for (const element of pattern.getElements()) {
            if (element.getDotDotDotToken()) dynamic.push(at(element));
            else note((element.getPropertyNameNode() ?? element.getNameNode()).getText().replace(/^["']|["']$/g, ""), !element.getInitializer(), rel);
          }
        }
      } else if (Node.isBinaryExpression(parent) && (parent.getOperatorToken().getKind() === SyntaxKind.InKeyword || (parent.getOperatorToken().getKind() === SyntaxKind.EqualsToken && parent.getLeft() === top))) {
        continue;
      } else {
        dynamic.push(at(node));
      }
    }
  };

  addFile(fnNode.getSourceFile());
  addRegion(fnNode);
  // An instance method also runs its class's constructor and field initializers.
  const owner = fnNode.getParent();
  if (owner && Node.isClassDeclaration(owner)) {
    for (const member of owner.getMembers()) if (Node.isConstructorDeclaration(member) || Node.isPropertyDeclaration(member)) addRegion(member);
  }
  while (queue.length) scan(queue.pop()!);

  return {
    variables: Object.fromEntries([...variables].sort(([a], [b]) => a.localeCompare(b)).map(([name, use]) => [name, { required: use.required, files: [...use.files].sort() }])),
    dynamic: [...new Set(dynamic)].sort(),
  };
}
