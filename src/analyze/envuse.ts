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

// `process.env`, `Bun.env` and `import.meta.env`.
function isEnvObject(node: Node): boolean {
  if (!Node.isPropertyAccessExpression(node) || node.getName() !== "env") return false;
  const owner = node.getExpression();
  if (Node.isIdentifier(owner)) return owner.getText() === "process" || owner.getText() === "Bun";
  return Node.isMetaProperty(owner);
}

const unwrap = (node: Node): Node => {
  let current = node;
  for (;;) {
    const parent = current.getParent();
    if (parent && (Node.isParenthesizedExpression(parent) || Node.isAsExpression(parent))) current = parent;
    else return current;
  }
};

// A read the code survives the variable being unset: a fallback, a presence check or a default.
function isOptionalRead(read: Node): boolean {
  const at = unwrap(read);
  const parent = at.getParent();
  if (!parent) return false;
  if (Node.isBinaryExpression(parent)) {
    const operator = parent.getOperatorToken().getKind();
    const left = parent.getLeft() === at;
    return left && (operator === SyntaxKind.QuestionQuestionToken || operator === SyntaxKind.BarBarToken || operator === SyntaxKind.AmpersandAmpersandToken);
  }
  if (Node.isPrefixUnaryExpression(parent)) return parent.getOperatorToken() === SyntaxKind.ExclamationToken;
  if (Node.isTypeOfExpression(parent)) return true;
  if (Node.isIfStatement(parent) || Node.isConditionalExpression(parent)) {
    return (Node.isIfStatement(parent) ? parent.getExpression() : parent.getCondition()) === at;
  }
  return false;
}

// What the project's own code reads from the environment, starting at `entry` and following its imports.
// Code inside `exclude` (other functions that share the entry's file) is not this function's.
export function scanEnvUse(entry: SourceFile, isAppFile: (file: SourceFile) => boolean, relative: (file: string) => string, exclude: readonly Node[] = []): EnvUse {
  const excluded = new Set<Node>(exclude);
  const isExcluded = (node: Node) => excluded.size > 0 && (excluded.has(node) || node.getAncestors().some((a) => excluded.has(a)));
  const variables = new Map<string, { required: boolean; files: Set<string> }>();
  const dynamic: string[] = [];
  const seen = new Set<SourceFile>();
  const queue = [entry];

  const note = (name: string, required: boolean, file: string) => {
    const earlier = variables.get(name) ?? { required: false, files: new Set<string>() };
    earlier.required ||= required;
    earlier.files.add(file);
    variables.set(name, earlier);
  };

  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file) || !isAppFile(file)) continue;
    seen.add(file);
    const rel = relative(file.getFilePath());
    const at = (node: Node) => `${rel}:${node.getStartLineNumber()}`;

    for (const decl of file.getImportDeclarations()) {
      const target = decl.isTypeOnly() ? undefined : decl.getModuleSpecifierSourceFile();
      if (target) queue.push(target);
    }
    for (const decl of file.getExportDeclarations()) {
      const target = decl.isTypeOnly() ? undefined : decl.getModuleSpecifierSourceFile();
      if (target) queue.push(target);
    }

    for (const node of file.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
      if (!isEnvObject(node) || isExcluded(node)) continue;
      const parent = node.getParent();
      if (Node.isPropertyAccessExpression(parent) && parent.getExpression() === node) {
        note(parent.getName(), !isOptionalRead(parent), rel);
      } else if (Node.isElementAccessExpression(parent) && parent.getExpression() === node) {
        const arg = parent.getArgumentExpression();
        if (arg && (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg))) note(arg.getLiteralValue(), !isOptionalRead(parent), rel);
        else dynamic.push(at(parent));
      } else if (Node.isVariableDeclaration(parent) && Node.isObjectBindingPattern(parent.getNameNode()) && parent.getInitializer() === node) {
        const pattern = parent.getNameNode();
        if (Node.isObjectBindingPattern(pattern)) {
          for (const element of pattern.getElements()) {
            if (element.getDotDotDotToken()) dynamic.push(at(element));
            else note((element.getPropertyNameNode() ?? element.getNameNode()).getText().replace(/^["']|["']$/g, ""), !element.getInitializer(), rel);
          }
        }
      } else if (Node.isBinaryExpression(parent) && parent.getRight() === node && parent.getOperatorToken().getKind() === SyntaxKind.InKeyword) {
        continue;
      } else {
        dynamic.push(at(node));
      }
    }
  }

  return {
    variables: Object.fromEntries([...variables].sort(([a], [b]) => a.localeCompare(b)).map(([name, use]) => [name, { required: use.required, files: [...use.files].sort() }])),
    dynamic: [...new Set(dynamic)].sort(),
  };
}
