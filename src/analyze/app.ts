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
import { BLOB_OPERATIONS, normalizeBlobPath, parseBlobUri, type BlobAccess, type BlobProvider } from "@cloudgear/blob";
import { METHODS } from "@cloudgear/functions";

export interface AnalyzedResource {
  kind: "BlobStore";
  name: string;
  provider: string;
  dry: boolean;
  file: string;
  line: number;
}

export interface StoreUse {
  resource: string;
  // Key prefix the store is confined to ("" for the whole bucket).
  path: string;
  accesses: Set<BlobAccess>;
}

export interface AnalyzedFunction {
  name: string;
  file: string;
  exportName: string;
  // Set when the routed function is a method of the exported object `exportName`.
  member?: string;
  // Name the function has at runtime (`fn.name`); the default route name. Empty when anonymous.
  declaredName: string;
  inputType?: string;
  routes: { method: string; path: string; name: string }[];
  // `${resource}\0${path}` -> accesses performed on that store
  uses: Map<string, StoreUse>;
}

interface Store {
  resource: AnalyzedResource;
  path: string;
}

interface Tally {
  store: Store;
  ops: Set<BlobAccess>;
  grants: Set<BlobAccess>;
  widenedAt?: Node;
}

export type Authentication = "iam" | "none";

export interface AppModel {
  provider: string;
  authenticated: Authentication;
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
  const resourceByDecl = new Map<Node, Store>();
  const resources = new Map<string, AnalyzedResource>();
  for (const expr of newExpressions.filter((e) => isClass(e, "@cloudgear/blob", "BlobStore"))) {
    const [providerArg, uriArg, optionsArg] = expr.getArguments();
    const provider = stringLiteral(providerArg, `${where(expr)}: BlobStore provider`);
    const uri = stringLiteral(uriArg, `${where(expr)}: BlobStore URI`);
    const storePath = readStorePath(optionsArg, where(expr));
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
    resourceByDecl.set(decl, { resource: existing ?? resource, path: storePath });
  }

  // Router
  const routers = newExpressions.filter((e) => isClass(e, "@cloudgear/functions", "FunctionRouter"));
  if (routers.length === 0) throw new Error(`No new FunctionRouter(...) found in ${relative(entry)} or its imports`);
  if (routers.length > 1) throw new Error(`Only one FunctionRouter per app is supported, found: ${routers.map(where).join(", ")}`);
  const router = routers[0]!;
  const provider = stringLiteral(router.getArguments()[0], `${where(router)}: FunctionRouter provider`);
  const authenticated = readAuthenticated(router.getArguments()[1], where(router));
  if (authenticated === "none") {
    warnings.push(`${where(router)}: authenticated is "none"; deployed functions can be invoked by anyone with their URL`);
  }
  if (authenticated === "none" && hasOption(router.getArguments()[1], "authenticate")) {
    warnings.push(
      `${where(router)}: authenticate is set but authenticated is "none"; deployed functions will not receive the caller's identity`,
    );
  }
  const routeNames = new Map<string, string>();

  const functions = new Map<Node, AnalyzedFunction>();
  const addCalls = collectAddCalls(router, where);
  if (addCalls.length === 0) throw new Error(`${where(router)}: FunctionRouter has no .url(...) routes`);
  for (const call of addCalls) {
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
      const target = exportTargetOf(decl);
      if (!target) {
        throw new Error(
          `${where(decl)}: "${fnArg.getText()}" must be exported so it can be bundled on its own (a named function, or a method of an exported object)`,
        );
      }
      const param = fnNode.getParameters()[0];
      fn = {
        name: target.member
          ? `${target.exportName}-${target.member}`
          : target.exportName === "default"
            ? path.basename(decl.getSourceFile().getFilePath(), ".ts")
            : target.exportName,
        declaredName: declaredNameOf(decl),
        file: relative(decl.getSourceFile().getFilePath()),
        exportName: target.exportName,
        member: target.member,
        inputType: param?.getTypeNode()?.getText(),
        routes: [],
        uses: new Map(),
      };
      const tallies = new Map<string, Tally>();
      collectUsage(fnNode, tallies, new Set());
      for (const [key, tally] of tallies) {
        let accesses = new Set([...tally.ops, ...tally.grants]);
        if (tally.widenedAt && tally.grants.size === 0) {
          accesses = new Set(ALL_ACCESS);
          warnings.push(
            `${where(tally.widenedAt)}: BlobStore "${tally.store.resource.name}" is passed around as a value; granting every operation on it (use grant(store, ...) to narrow)`,
          );
        }
        fn.uses.set(key, { resource: tally.store.resource.name, path: tally.store.path, accesses });
      }
      functions.set(decl, fn);
    }
    checkPathParams(routePath, fnNode, where(call));
    if (fn.routes.some((r) => r.method === method && r.path === routePath)) {
      throw new Error(`${where(call)}: route "${method} ${routePath}" is registered twice`);
    }
    const routeName = readRouteName(call.getArguments()[3], where(call)) ?? (fn.declaredName || `${method} ${routePath}`);
    const clashing = routeNames.get(routeName);
    if (clashing) throw new Error(`${where(call)}: route name "${routeName}" is already used by ${clashing}; pass { name } to tell them apart`);
    routeNames.set(routeName, `${method} ${routePath}`);
    fn.routes.push({ method, path: routePath, name: routeName });
  }

  const byName = new Map<string, AnalyzedFunction>();
  for (const fn of functions.values()) {
    const clash = byName.get(fn.name);
    if (clash) throw new Error(`Two routed functions are named "${fn.name}" (${clash.file}, ${fn.file}); rename one`);
    byName.set(fn.name, fn);
  }

  warnModuleLevelUse();

  return {
    provider,
    authenticated,
    entry: relative(entry),
    resources: [...resources.values()],
    functions: [...functions.values()],
    warnings: [...new Set(warnings)],
  };

  function collectUsage(root: Node, tallies: Map<string, Tally>, visited: Set<Node>) {
    visited.add(root);
    const trace = (target: Node) => {
      if (!visited.has(target)) collectUsage(target, tallies, visited);
    };
    const visit = (node: Node) => {
      if (!Node.isIdentifier(node)) return;
      for (const decl of declarationsOf(node)) {
        if (Node.isVariableDeclaration(decl) && decl.getNameNode() === node) continue;
        const store = resourceByDecl.get(decl);
        if (store) {
          const key = `${store.resource.name}\0${store.path}`;
          const tally = tallies.get(key) ?? { store, ops: new Set<BlobAccess>(), grants: new Set<BlobAccess>() };
          tallies.set(key, tally);
          const found = accessesAt(node);
          for (const access of found.ops ?? []) tally.ops.add(access);
          for (const access of found.grants ?? []) tally.grants.add(access);
          if (found.widened) tally.widenedAt ??= node;
          continue;
        }
        if (!isLocal(decl)) continue;
        const callee = functionNode(decl);
        if (callee) {
          trace(callee);
        } else if (Node.isClassDeclaration(decl)) {
          for (const member of decl.getMembers()) {
            if (Node.isConstructorDeclaration(member)) trace(member);
            else if (Node.isPropertyDeclaration(member) && member.getInitializer()) trace(member.getInitializerOrThrow());
          }
        } else if (
          (Node.isVariableDeclaration(decl) || Node.isPropertyAssignment(decl) || Node.isPropertyDeclaration(decl)) &&
          decl.getInitializer()
        ) {
          trace(decl.getInitializerOrThrow());
        }
      }
    };
    visit(root);
    root.forEachDescendant((node) => void visit(node));
  }

  // Declarations an identifier refers to; `{ store }` and `obj.store` lead back to the variable.
  function declarationsOf(node: Node): Node[] {
    const parent = node.getParent();
    const symbol =
      Node.isShorthandPropertyAssignment(parent) && parent.getNameNode() === node ? parent.getValueSymbol() : node.getSymbol();
    return (resolveSymbol(symbol)?.getDeclarations() ?? []).flatMap((decl) =>
      Node.isShorthandPropertyAssignment(decl) ? (resolveSymbol(decl.getValueSymbol())?.getDeclarations() ?? []) : [decl],
    );
  }

  function warnModuleLevelUse() {
    for (const decl of resourceByDecl.keys()) {
      const name = (decl as VariableDeclaration).getNameNode();
      if (!Node.isIdentifier(name)) continue;
      for (const ref of name.findReferencesAsNodes()) {
        const parent = ref.getParent();
        const isOperation =
          Node.isPropertyAccessExpression(parent) &&
          parent.getExpression() === ref &&
          Object.hasOwn(BLOB_OPERATIONS, parent.getName());
        if (isOperation && !ref.getFirstAncestor((a) => Node.isFunctionLikeDeclaration(a) || Node.isClassDeclaration(a))) {
          warnings.push(
            `${where(ref)}: BlobStore "${resourceByDecl.get(decl)!.resource.name}" is used outside any function; no permission is inferred for it`,
          );
        }
      }
    }
  }

  function accessesAt(start: Node): { ops?: BlobAccess[]; grants?: BlobAccess[]; widened?: true } {
    // `this.store` and `svc.store` name the store as a property; judge the use of that whole expression.
    const owner = start.getParent();
    const node = Node.isPropertyAccessExpression(owner) && owner.getNameNode() === start ? owner : start;
    const parent = node.getParent();
    if (Node.isPropertyAccessExpression(parent) && parent.getExpression() === node) {
      const member = parent.getName();
      if (Object.hasOwn(BLOB_OPERATIONS, member)) return { ops: [...BLOB_OPERATIONS[member as keyof typeof BLOB_OPERATIONS]] };
      return {};
    }
    if (Node.isCallExpression(parent) && parent.getArguments()[0] === node && isGrantCall(parent)) {
      return { grants: readGrant(parent) };
    }
    return { widened: true };
  }

  function isGrantCall(call: CallExpression): boolean {
    const callee = call.getExpression();
    if (!Node.isIdentifier(callee)) return false;
    const decl = resolveSymbol(callee.getSymbol())?.getDeclarations()[0];
    return !!decl && Node.isFunctionDeclaration(decl) && decl.getName() === "grant" && packages.nameOf(decl.getSourceFile().getFilePath()) === "@cloudgear/blob";
  }

  function readGrant(call: CallExpression): BlobAccess[] {
    const accesses = call.getArguments().slice(1).map((arg) => stringLiteral(arg, `${where(call)}: grant access`));
    if (accesses.length === 0) throw new Error(`${where(call)}: grant(store, ...) needs at least one access`);
    for (const access of accesses) {
      if (!ALL_ACCESS.includes(access as BlobAccess)) {
        throw new Error(`${where(call)}: unknown access "${access}" in grant(); expected ${ALL_ACCESS.map((a) => `"${a}"`).join(", ")}`);
      }
    }
    return accesses as BlobAccess[];
  }
}

// Property key text, accepting identifiers and string literals ("path": ...); computed keys cannot be analyzed.
function propName(prop: Node): string | undefined {
  if (!Node.isPropertyAssignment(prop) && !Node.isShorthandPropertyAssignment(prop) && !Node.isMethodDeclaration(prop)) return undefined;
  const key = prop.getNameNode();
  if (Node.isIdentifier(key)) return key.getText();
  if (Node.isStringLiteral(key) || Node.isNoSubstitutionTemplateLiteral(key)) return key.getLiteralValue();
  if (Node.isNumericLiteral(key)) return key.getLiteralText();
  throw new Error(`${relative(prop.getSourceFile().getFilePath())}:${prop.getStartLineNumber()}: computed property keys cannot be analyzed`);
}

function readAuthenticated(options: Node | undefined, at: string): Authentication {
  if (!options) return "iam";
  if (!Node.isObjectLiteralExpression(options)) {
    throw new Error(`${at}: FunctionRouter options must be an object literal so cloudgear can read them`);
  }
  let authenticated: Authentication = "iam";
  for (const prop of options.getProperties()) {
    if (Node.isSpreadAssignment(prop)) throw new Error(`${at}: spread in FunctionRouter options cannot be analyzed`);
    const name = propName(prop);
    if (name !== "authenticated") continue;
    const value = Node.isPropertyAssignment(prop) ? stringLiteral(prop.getInitializer(), `${at}: authenticated`) : undefined;
    if (value !== "iam" && value !== "none") throw new Error(`${at}: authenticated must be the literal "iam" or "none"`);
    authenticated = value;
  }
  return authenticated;
}

function hasOption(options: Node | undefined, name: string): boolean {
  return (
    !!options &&
    Node.isObjectLiteralExpression(options) &&
    options.getProperties().some((prop) => propName(prop) === name)
  );
}

function readRouteName(options: Node | undefined, at: string): string | undefined {
  if (!options) return undefined;
  if (!Node.isObjectLiteralExpression(options)) throw new Error(`${at}: route options must be an object literal`);
  for (const prop of options.getProperties()) {
    if (Node.isSpreadAssignment(prop)) throw new Error(`${at}: spread in route options cannot be analyzed`);
    if (Node.isPropertyAssignment(prop) && propName(prop) === "name") {
      const name = stringLiteral(prop.getInitializer(), `${at}: route name`);
      if (!name) throw new Error(`${at}: route name must not be empty`);
      return name;
    }
    if (Node.isShorthandPropertyAssignment(prop) && propName(prop) === "name") {
      throw new Error(`${at}: route name must be a string literal`);
    }
  }
  return undefined;
}

const ROUTER_MEMBERS = new Set(["listen", "fetch", "provider", "mode"]);

// Follows .url chains through variables; throws if the router flows anywhere untraceable.
function collectAddCalls(router: NewExpression, where: (node: Node) => string): CallExpression[] {
  const calls: CallExpression[] = [];
  const followed = new Set<Node>();

  const follow = (start: Node) => {
    const top = walkChain(start, calls);
    const parent = top.getParent();
    if (Node.isVariableDeclaration(parent) && parent.getInitializer() === top) {
      const name = parent.getNameNode();
      if (!Node.isIdentifier(name)) throw new Error(`${where(parent)}: assign the router to a plain variable so its routes can be traced`);
      if (followed.has(parent)) return;
      followed.add(parent);
      for (const ref of name.findReferencesAsNodes()) if (ref !== name) follow(ref);
      return;
    }
    if (Node.isExpressionStatement(parent)) return;
    // Usages in other files are separate references, followed on their own.
    if (
      Node.isImportSpecifier(parent) ||
      Node.isExportSpecifier(parent) ||
      Node.isTypeQuery(parent) ||
      Node.isVoidExpression(parent)
    ) {
      return;
    }
    if (Node.isExportAssignment(parent)) {
      throw new Error(`${where(top)}: export the router with a name (export const router = ...) so its routes can be traced`);
    }
    if (Node.isPropertyAccessExpression(parent) && parent.getExpression() === top && ROUTER_MEMBERS.has(parent.getName())) return;
    throw new Error(
      `${where(top)}: the router is used in a way cloudgear cannot trace ("${parent?.getText().slice(0, 60)}"); keep .url(...) calls on the router variable`,
    );
  };

  follow(router);
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
      parent.getName() === "url" &&
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

function readStorePath(options: Node | undefined, at: string): string {
  if (!options) return "";
  if (!Node.isObjectLiteralExpression(options)) throw new Error(`${at}: BlobStore options must be an object literal`);
  for (const prop of options.getProperties()) {
    if (Node.isSpreadAssignment(prop)) throw new Error(`${at}: spread in BlobStore options cannot be analyzed`);
    if (Node.isShorthandPropertyAssignment(prop) && propName(prop) === "path") {
      throw new Error(`${at}: BlobStore path must be a string literal`);
    }
    if (Node.isPropertyAssignment(prop) && propName(prop) === "path") {
      try {
        return normalizeBlobPath(stringLiteral(prop.getInitializer(), `${at}: BlobStore path`));
      } catch (err) {
        throw new Error(`${at}: ${(err as Error).message}`);
      }
    }
  }
  return "";
}

// A routed function is bundled through a named export, or as a method of an exported object.
function declaredNameOf(decl: Node): string {
  if (Node.isFunctionDeclaration(decl)) return decl.getName() ?? "";
  if (Node.isVariableDeclaration(decl)) {
    const init = decl.getInitializer();
    // `const d = function inner() {}` has the runtime name "inner".
    return Node.isFunctionExpression(init) && init.getName() ? init.getName()! : decl.getName();
  }
  if (Node.isMethodDeclaration(decl) || Node.isPropertyAssignment(decl)) return propName(decl) ?? "";
  return "";
}

function exportTargetOf(decl: Node): { exportName: string; member?: string } | undefined {
  const direct = exportNameOf(decl);
  if (direct) return { exportName: direct };
  if (!Node.isMethodDeclaration(decl) && !Node.isPropertyAssignment(decl)) return undefined;
  const object = decl.getParent();
  const variable = Node.isObjectLiteralExpression(object) ? object.getParentIfKind(SyntaxKind.VariableDeclaration) : undefined;
  const exportName = variable && variable.getInitializer() === object ? exportNameOf(variable) : undefined;
  const member = decl.getName();
  if (!exportName || !/^[A-Za-z_$][\w$]*$/.test(member)) return undefined;
  return { exportName, member };
}

function functionNode(decl: Node) {
  if (Node.isFunctionDeclaration(decl) || Node.isMethodDeclaration(decl)) return decl;
  if (Node.isVariableDeclaration(decl) || Node.isPropertyAssignment(decl)) {
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

