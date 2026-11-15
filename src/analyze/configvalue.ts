import { Node, SyntaxKind } from "ts-morph";

export type SetupEnv = Record<string, string | undefined>;

type Resolved = { value: string } | { unset: string } | undefined;

const ENV_OBJECTS = new Set(["process.env", "Bun.env", "import.meta.env"]);

export function configString(node: Node | undefined, what: string, env: SetupEnv): string {
  const result = node && resolve(node, env, new Set());
  if (result && "value" in result) return result.value;
  if (result) throw new Error(`${what}: environment variable ${result.unset} is unset or empty; export it, pass --env-file, or give a default with ??`);
  throw new Error(`${what} must be a string literal or an environment variable, got: ${node?.getText() ?? "nothing"}`);
}

function resolve(node: Node, env: SetupEnv, seen: Set<Node>): Resolved {
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) return { value: node.getLiteralValue() };
  if (Node.isParenthesizedExpression(node) || Node.isNonNullExpression(node) || Node.isAsExpression(node) || Node.isSatisfiesExpression(node)) {
    return resolve(node.getExpression(), env, seen);
  }
  if (Node.isTemplateExpression(node)) {
    const parts: string[] = [node.getHead().getLiteralText()];
    for (const span of node.getTemplateSpans()) {
      const part = resolve(span.getExpression(), env, seen);
      if (!part || "unset" in part) return part;
      parts.push(part.value, span.getLiteral().getLiteralText());
    }
    return { value: parts.join("") };
  }
  if (Node.isBinaryExpression(node)) return resolveBinary(node, env, seen);
  const name = envName(node);
  if (name !== undefined) return env[name] ? { value: env[name]! } : { unset: name };
  if (Node.isIdentifier(node)) {
    const parent = node.getParent();
    const symbol = Node.isShorthandPropertyAssignment(parent) ? parent.getValueSymbol() : node.getSymbol();
    const declaration = symbol?.getDeclarations()[0];
    if (!declaration || !Node.isVariableDeclaration(declaration) || seen.has(declaration)) return undefined;
    const initializer = declaration.getInitializer();
    if (!initializer || declaration.getVariableStatement()?.getDeclarationKind() !== "const") return undefined;
    return resolve(initializer, env, new Set([...seen, declaration]));
  }
  return undefined;
}

function resolveBinary(node: import("ts-morph").BinaryExpression, env: SetupEnv, seen: Set<Node>): Resolved {
  const operator = node.getOperatorToken().getKind();
  const left = resolve(node.getLeft(), env, seen);
  if (operator === SyntaxKind.PlusToken) {
    const right = resolve(node.getRight(), env, seen);
    if (!left || !right) return undefined;
    if ("unset" in left) return left;
    if ("unset" in right) return right;
    return { value: left.value + right.value };
  }
  if (operator === SyntaxKind.QuestionQuestionToken || operator === SyntaxKind.BarBarToken) {
    if (!left) return undefined;
    const useRight = "unset" in left || (operator === SyntaxKind.BarBarToken && left.value === "");
    return useRight ? resolve(node.getRight(), env, seen) : left;
  }
  return undefined;
}

function envName(node: Node): string | undefined {
  if (Node.isPropertyAccessExpression(node) && ENV_OBJECTS.has(node.getExpression().getText())) return node.getName();
  if (Node.isElementAccessExpression(node) && ENV_OBJECTS.has(node.getExpression().getText())) {
    const key = node.getArgumentExpression();
    if (key && (Node.isStringLiteral(key) || Node.isNoSubstitutionTemplateLiteral(key))) return key.getLiteralValue();
  }
  return undefined;
}
