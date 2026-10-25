import fs from "node:fs";
import path from "node:path";
import {
  Node,
  Project,
  SyntaxKind,
  type CallExpression,
  type NewExpression,
  type Symbol as MorphSymbol,
  type VariableDeclaration,
} from "ts-morph";
import { BLOB_OPERATIONS, parseBlobUri, type BlobAccess, type BlobProvider } from "@cloudgear/blob";
import { METHODS } from "@cloudgear/functions";

export interface AnalyzedResource {
  kind: "BlobStore";
  name: string;
  provider: string;
  dry: boolean;
  file: string;
  line: number;
}

export interface AnalyzedFunction {
  name: string;
  file: string;
  exportName: string;
  inputType?: string;
  routes: { method: string; path: string }[];
  // resource name -> accesses performed on it
  uses: Map<string, Set<BlobAccess>>;
}

export interface AppModel {
  provider: string;
  entry: string;
  resources: AnalyzedResource[];
  functions: AnalyzedFunction[];
  warnings: string[];
}

const DIRECTIVE = /^cloudgear:\s*(.+)$/;
const KNOWN_DIRECTIVES = new Set(["dry"]);
const ALL_ACCESS = [...new Set(Object.values(BLOB_OPERATIONS).flat())] as BlobAccess[];

export function analyzeApp(entryPath: string): AppModel {
  const entry = path.resolve(entryPath);
  const tsConfigFilePath = findUp(path.dirname(entry), "tsconfig.json");
  const project = new Project(
    tsConfigFilePath ? { tsConfigFilePath, skipAddingFilesFromTsConfig: true } : {},
  );
  project.addSourceFileAtPath(entry);
  project.resolveSourceFileDependencies();

  const packages = new PackageNames();
  const localFiles = project
    .getSourceFiles()
    .filter((file) => !file.isDeclarationFile() && !file.isInNodeModules() && !packages.isCloudgear(file.getFilePath()));
  const isLocal = (node: Node) => localFiles.includes(node.getSourceFile());

  const warnings: string[] = [];
  const where = (node: Node) => `${relative(node.getSourceFile().getFilePath())}:${node.getStartLineNumber()}`;
  const isClass = (expr: NewExpression, pkg: string, name: string) => {
    const decl = resolveSymbol(expr.getExpression().getSymbol())?.getDeclarations()[0];
    return !!decl && Node.isClassDeclaration(decl) && decl.getName() === name && packages.nameOf(decl.getSourceFile().getFilePath()) === pkg;
  };
  const newExpressions = localFiles.flatMap((file) => file.getDescendantsOfKind(SyntaxKind.NewExpression));

  // Resources
  const resourceByDecl = new Map<Node, AnalyzedResource>();
  const resources = new Map<string, AnalyzedResource>();
  for (const expr of newExpressions.filter((e) => isClass(e, "@cloudgear/blob", "BlobStore"))) {
    const [providerArg, uriArg] = expr.getArguments();
    const provider = stringLiteral(providerArg, `${where(expr)}: BlobStore provider`);
    const uri = stringLiteral(uriArg, `${where(expr)}: BlobStore URI`);
    const decl = expr.getParentIfKind(SyntaxKind.VariableDeclaration);
    if (!decl || decl.getInitializer() !== expr) {
      throw new Error(`${where(expr)}: assign new BlobStore(...) to a variable so its usage can be traced`);
    }
    const resource: AnalyzedResource = {
      kind: "BlobStore",
      name: parseBlobUri(provider as BlobProvider, uri),
      provider,
      dry: readDirectives(decl, where(expr)).has("dry"),
      file: relative(expr.getSourceFile().getFilePath()),
      line: expr.getStartLineNumber(),
    };
    const existing = resources.get(resource.name);
    if (existing && (existing.dry !== resource.dry || existing.provider !== resource.provider)) {
      throw new Error(
        `${where(expr)}: BlobStore "${resource.name}" is also declared at ${existing.file}:${existing.line} with a different provider or directives`,
      );
    }
    resources.set(resource.name, existing ?? resource);
    resourceByDecl.set(decl, existing ?? resource);
  }

  // Router
  const routers = newExpressions.filter((e) => isClass(e, "@cloudgear/functions", "FunctionRouter"));
  if (routers.length === 0) throw new Error(`No new FunctionRouter(...) found in ${relative(entry)} or its imports`);
  if (routers.length > 1) throw new Error(`Only one FunctionRouter per app is supported, found: ${routers.map(where).join(", ")}`);
  const router = routers[0]!;
  const provider = stringLiteral(router.getArguments()[0], `${where(router)}: FunctionRouter provider`);

  const functions = new Map<Node, AnalyzedFunction>();
  for (const call of collectAddCalls(router)) {
    const [methodArg, pathArg, fnArg] = call.getArguments();
    const method = stringLiteral(methodArg, `${where(call)}: route method`).toUpperCase();
    if (!(METHODS as readonly string[]).includes(method)) throw new Error(`${where(call)}: unsupported HTTP method "${method}"`);
    const routePath = stringLiteral(pathArg, `${where(call)}: route path`);
    if (!fnArg) throw new Error(`${where(call)}: missing function argument`);

    const decl = resolveSymbol(fnArg.getSymbol())?.getDeclarations()[0];
    const fnNode = decl && functionNode(decl);
    if (!decl || !fnNode || !isLocal(decl)) {
      throw new Error(`${where(call)}: "${fnArg.getText()}" must reference a named function declared in your project`);
    }
    let fn = functions.get(decl);
    if (!fn) {
      const exportName = exportNameOf(decl);
      if (!exportName) throw new Error(`${where(decl)}: "${fnArg.getText()}" must be exported so it can be bundled on its own`);
      const param = fnNode.getParameters()[0];
      fn = {
        name: exportName === "default" ? path.basename(decl.getSourceFile().getFilePath(), ".ts") : exportName,
        file: relative(decl.getSourceFile().getFilePath()),
        exportName,
        inputType: param?.getTypeNode()?.getText(),
        routes: [],
        uses: new Map(),
      };
      collectUsage(fnNode, fn.uses, new Set());
      functions.set(decl, fn);
    }
    checkPathParams(routePath, fnNode, where(call));
    if (fn.routes.some((r) => r.method === method && r.path === routePath)) {
      throw new Error(`${where(call)}: route "${method} ${routePath}" is registered twice`);
    }
    fn.routes.push({ method, path: routePath });
  }

  const byName = new Map<string, AnalyzedFunction>();
  for (const fn of functions.values()) {
    const clash = byName.get(fn.name);
    if (clash) throw new Error(`Two routed functions are named "${fn.name}" (${clash.file}, ${fn.file}); rename one`);
    byName.set(fn.name, fn);
  }

  return {
    provider,
    entry: relative(entry),
    resources: [...resources.values()],
    functions: [...functions.values()],
    warnings,
  };

  function collectUsage(fnNode: Node, uses: Map<string, Set<BlobAccess>>, visited: Set<Node>) {
    visited.add(fnNode);
    fnNode.forEachDescendant((node) => {
      if (!Node.isIdentifier(node)) return;
      for (const decl of resolveSymbol(node.getSymbol())?.getDeclarations() ?? []) {
        if (Node.isVariableDeclaration(decl) && decl.getNameNode() === node) continue;
        const resource = resourceByDecl.get(decl);
        if (resource) {
          const accesses = uses.get(resource.name) ?? new Set();
          for (const access of accessesAt(node, resource)) accesses.add(access);
          uses.set(resource.name, accesses);
          continue;
        }
        const callee = functionNode(decl);
        if (callee && isLocal(callee) && !visited.has(callee)) collectUsage(callee, uses, visited);
      }
    });
  }

  function accessesAt(node: Node, resource: AnalyzedResource): BlobAccess[] {
    const parent = node.getParent();
    if (Node.isPropertyAccessExpression(parent) && parent.getExpression() === node) {
      const member = parent.getName();
      if (member in BLOB_OPERATIONS) return [...BLOB_OPERATIONS[member as keyof typeof BLOB_OPERATIONS]];
      return [];
    }
    warnings.push(
      `${where(node)}: BlobStore "${resource.name}" is passed around as a value; granting every operation on it`,
    );
    return ALL_ACCESS;
  }
}

function collectAddCalls(router: NewExpression): CallExpression[] {
  const calls: CallExpression[] = [];
  const top = walkChain(router, calls);
  const decl = top.getParentIfKind(SyntaxKind.VariableDeclaration);
  if (decl && decl.getInitializer() === top && Node.isIdentifier(decl.getNameNode())) {
    for (const ref of decl.getNameNode().asKindOrThrow(SyntaxKind.Identifier).findReferencesAsNodes()) {
      if (ref !== decl.getNameNode()) walkChain(ref, calls);
    }
  }
  return calls;
}

function walkChain(start: Node, calls: CallExpression[]): Node {
  let node = start;
  for (;;) {
    const parent = node.getParent();
    if (Node.isParenthesizedExpression(parent)) {
      node = parent;
      continue;
    }
    const call = parent?.getParent();
    if (
      Node.isPropertyAccessExpression(parent) &&
      parent.getExpression() === node &&
      parent.getName() === "add" &&
      Node.isCallExpression(call) &&
      call.getExpression() === parent
    ) {
      calls.push(call);
      node = call;
      continue;
    }
    return node;
  }
}

function functionNode(decl: Node) {
  if (Node.isFunctionDeclaration(decl)) return decl;
  if (Node.isVariableDeclaration(decl)) {
    const init = decl.getInitializer();
    if (Node.isArrowFunction(init) || Node.isFunctionExpression(init)) return init;
  }
  return undefined;
}

function exportNameOf(decl: Node): string | undefined {
  for (const [name, decls] of decl.getSourceFile().getExportedDeclarations()) {
    if ((decls as Node[]).includes(decl)) return name;
  }
  return undefined;
}

function checkPathParams(routePath: string, fnNode: ReturnType<typeof functionNode> & {}, at: string) {
  const params = [...routePath.matchAll(/\{([A-Za-z_$][\w$]*)\}/g)].map((m) => m[1]!);
  const param = fnNode.getParameters()[0];
  if (!params.length || !param) return;
  const type = param.getType();
  if (type.isAny() || type.isUnknown()) return;
  const props = new Set(type.getApparentProperties().map((p) => p.getName()));
  const missing = params.filter((p) => !props.has(p));
  if (missing.length) {
    throw new Error(`${at}: path param(s) ${missing.map((p) => `"${p}"`).join(", ")} missing from input type ${param.getType().getText(param)}`);
  }
}

function readDirectives(decl: VariableDeclaration, at: string): Set<string> {
  const statement = decl.getVariableStatement() ?? decl;
  const comments = [...statement.getLeadingCommentRanges(), ...statement.getTrailingCommentRanges()];
  const directives = new Set<string>();
  for (const comment of comments) {
    const match = DIRECTIVE.exec(comment.getText().replace(/^\/[/*]\s*|\s*\*\/$/g, ""));
    if (!match) continue;
    for (const token of match[1]!.split(/[\s,]+/).filter(Boolean)) {
      if (!KNOWN_DIRECTIVES.has(token)) throw new Error(`${at}: unknown cloudgear directive "${token}"`);
      directives.add(token);
    }
  }
  return directives;
}

function stringLiteral(node: Node | undefined, what: string): string {
  if (node && (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node))) return node.getLiteralValue();
  throw new Error(`${what} must be a string literal, got: ${node?.getText() ?? "nothing"}`);
}

function resolveSymbol(symbol: MorphSymbol | undefined): MorphSymbol | undefined {
  return symbol?.isAlias() ? symbol.getAliasedSymbol() : symbol;
}

function relative(file: string): string {
  return path.relative(process.cwd(), file) || ".";
}

function findUp(dir: string, name: string): string | undefined {
  for (let current = dir; ; current = path.dirname(current)) {
    const candidate = path.join(current, name);
    if (fs.existsSync(candidate)) return candidate;
    if (path.dirname(current) === current) return undefined;
  }
}

class PackageNames {
  private readonly cache = new Map<string, string | undefined>();

  nameOf(file: string): string | undefined {
    const dir = path.dirname(file);
    if (!this.cache.has(dir)) {
      const pkg = findUp(dir, "package.json");
      this.cache.set(dir, pkg ? JSON.parse(fs.readFileSync(pkg, "utf8")).name : undefined);
    }
    return this.cache.get(dir);
  }

  isCloudgear(file: string): boolean {
    return this.nameOf(file)?.startsWith("@cloudgear/") ?? false;
  }
}

