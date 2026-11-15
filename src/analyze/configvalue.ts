import { Node, SyntaxKind } from "ts-morph";

export type SetupEnv = Record<string, string | undefined>;

const ENV_OBJECTS = new Set(["process.env", "Bun.env", "import.meta.env"]);

export function configString(node: Node | undefined, what: string, env: SetupEnv): string {
  const value = node && resolve(node, what, env, new Set());
  if (value === undefined) throw new Error(`${what} must be a string literal or an environment variable, got: ${node?.getText() ?? "nothing"}`);
  return value;
}

function resolve(node: Node, what: string, env: SetupEnv, seen: Set<Node>): string | undefined {
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) return node.getLiteralValue();
  if (Node.isParenthesizedExpression(node) || Node.isNonNullExpression(node) || Node.isAsExpression(node) || Node.isSatisfiesExpression(node)) {
    return resolve(node.getExpression(), what, env, seen);
  }
  if (Node.isTemplateExpression(node)) {
    let text = node.getHead().getLiteralText();
    for (const span of node.getTemplateSpans()) {
      const part = resolve(span.getExpression(), what, env, seen);
      if (part === undefined) return undefined;
      text += part + span.getLiteral().getLiteralText();
    }
    return text;
  }
  if (Node.isBinaryExpression(node)) {
    const operator = node.getOperatorToken().getKind();
    if (operator === SyntaxKind.PlusToken) {
      const left = resolve(node.getLeft(), what, env, seen);
      const right = resolve(node.getRight(), what, env, seen);
      return left === undefined || right === undefined ? undefined : left + right;
    }
    if (operator === SyntaxKind.QuestionQuestionToken || operator === SyntaxKind.BarBarToken) {
      return resolveOptional(node.getLeft(), what, env, seen) ?? resolve(node.getRight(), what, env, seen);
    }
    return undefined;
  }
  const name = envName(node);
  if (name !== undefined) {
    const value = env[name];
    if (value === undefined || value === "") throw new Error(`${what}: environment variable ${name} is not set; export it or pass --env-file`);
    return value;
  }
  if (Node.isIdentifier(node)) {
    const parent = node.getParent();
    const symbol = Node.isShorthandPropertyAssignment(parent) ? parent.getValueSymbol() : node.getSymbol();
    const declaration = symbol?.getDeclarations()[0];
    if (!declaration || !Node.isVariableDeclaration(declaration) || seen.has(declaration)) return undefined;
    const statement = declaration.getVariableStatement();
    const initializer = declaration.getInitializer();
    if (!statement || !initializer || statement.getDeclarationKind() !== "const") return undefined;
    return resolve(initializer, what, env, new Set([...seen, declaration]));
  }
  return undefined;
}

function resolveOptional(node: Node, what: string, env: SetupEnv, seen: Set<Node>): string | undefined {
  const name = envName(node);
  if (name !== undefined) return env[name] || undefined;
  return resolve(node, what, env, seen);
}

function envName(node: Node): string | undefined {
  if (Node.isPropertyAccessExpression(node) && ENV_OBJECTS.has(node.getExpression().getText())) return node.getName();
  if (Node.isElementAccessExpression(node) && ENV_OBJECTS.has(node.getExpression().getText())) {
    const key = node.getArgumentExpression();
    if (key && (Node.isStringLiteral(key) || Node.isNoSubstitutionTemplateLiteral(key))) return key.getLiteralValue();
  }
  return undefined;
}
