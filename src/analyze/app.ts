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
import { DNS } from "@cloudgear/dns";
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

export interface EdgeModel {
  dns?: { provider: string; domain: string; zone: string };
  certificate?: { domain: string };
  cdn?: {
    provider: string;
    domain: string;
    // Name of the bucket resource and the key prefix of the static site within it.
    bucket: string;
    path: string;
    behaviors: { pathPattern: string; function: string; methods: string[] }[];
  };
}

export interface AppModel extends EdgeModel {
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
  const publicRoutes = new Map<string, boolean>();

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
    const routeOptions = readRouteOptions(call.getArguments()[3], where(call));
    publicRoutes.set(`${method} ${routePath}`, routeOptions.public);
    const routeName = routeOptions.name ?? (fn.declaredName || `${method} ${routePath}`);
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
  const edge = analyzeEdge();

  return {
    ...edge,
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

  function analyzeEdge(): EdgeModel {
    const ofClass = (pkg: string, name: string) => newExpressions.filter((e) => isClass(e, pkg, name));
    const dnsExprs = ofClass("@cloudgear/dns", "DNS");
    const certExprs = ofClass("@cloudgear/cdn", "Cert");
    const cdnExprs = ofClass("@cloudgear/cdn", "CDN");
    const routerCdn = readCdnReference(router.getArguments()[1], where(router));

    if (!dnsExprs.length && !certExprs.length && !cdnExprs.length) {
      if (routerCdn) throw new Error(`${where(router)}: the router's cdn option needs a CDN declared with new CDN(...)`);
      return {};
    }
    for (const [name, exprs] of [["DNS", dnsExprs], ["Cert", certExprs], ["CDN", cdnExprs]] as const) {
      if (exprs.length > 1) throw new Error(`Only one ${name} per app is supported, found: ${exprs.map(where).join(", ")}`);
    }
    if (routerCdn !== undefined && !cdnExprs.length) {
      throw new Error(`${where(router)}: the router's cdn needs a CDN declared with new CDN(...)`);
    }
    const [dnsExpr] = dnsExprs;
    const [certExpr] = certExprs;
    const [cdnExpr] = cdnExprs;

    const initializerOf = (node: Node | undefined, what: string, at: string): NewExpression => {
      const decl = node && Node.isIdentifier(node) ? resolveSymbol(node.getSymbol())?.getDeclarations()[0] : undefined;
      const init = decl && Node.isVariableDeclaration(decl) ? decl.getInitializer() : undefined;
      if (!init || !Node.isNewExpression(init)) throw new Error(`${at}: ${what} must be a variable initialized with new ...(...)`);
      return init;
    };

    let dns: EdgeModel["dns"];
    let domainName: string | undefined;
    if (dnsExpr) {
      const at = where(dnsExpr);
      const [providerArg, domainArg, optionsArg] = dnsExpr.getArguments();
      const dnsProvider = stringLiteral(providerArg, `${at}: DNS provider`);
      if (dnsProvider !== "gandi" && dnsProvider !== "aws") throw new Error(`${at}: DNS provider must be "gandi" or "aws"`);
      const zone = readStringOption(optionsArg, "zone", `${at}: DNS options`);
      try {
        const parsed = new DNS(dnsProvider, stringLiteral(domainArg, `${at}: DNS domain`), zone ? { zone } : {});
        dns = { provider: dnsProvider, domain: parsed.domain, zone: parsed.zone };
      } catch (err) {
        throw new Error(`${at}: ${(err as Error).message}`);
      }
      domainName = dns.domain;
      if (dns.domain === dns.zone) {
        throw new Error(`${at}: "${dns.domain}" is the zone apex, which cannot be a CNAME; serve the site from a subdomain`);
      }
    }

    let certificate: EdgeModel["certificate"];
    if (certExpr) {
      const at = where(certExpr);
      const [providerArg, dnsArg] = certExpr.getArguments();
      if (stringLiteral(providerArg, `${at}: Cert provider`) !== "aws") throw new Error(`${at}: Cert provider must be "aws"`);
      if (!dnsExpr || initializerOf(dnsArg, "the Cert's DNS", at) !== dnsExpr) throw new Error(`${at}: the Cert must use the app's DNS`);
      certificate = { domain: domainName! };
    }

    let cdn: EdgeModel["cdn"];
    if (cdnExpr) {
      const at = where(cdnExpr);
      const [providerArg, dnsArg, optionsArg] = cdnExpr.getArguments();
      if (stringLiteral(providerArg, `${at}: CDN provider`) !== "aws") throw new Error(`${at}: CDN provider must be "aws"`);
      if (!dnsExpr || initializerOf(dnsArg, "the CDN's DNS", at) !== dnsExpr) throw new Error(`${at}: the CDN must use the app's DNS`);
      if (!optionsArg || !Node.isObjectLiteralExpression(optionsArg)) throw new Error(`${at}: CDN options must be an object literal with cert and bucket`);

      let bucketStore: Store | undefined;
      let certOk = false;
      for (const prop of optionsArg.getProperties()) {
        if (Node.isSpreadAssignment(prop)) throw new Error(`${at}: spread in CDN options cannot be analyzed`);
        const key = propName(prop);
        const decl = valueDeclaration(prop);
        if (key === "cert") {
          const init = decl && Node.isVariableDeclaration(decl) ? decl.getInitializer() : undefined;
          certOk = !!certExpr && init === certExpr;
        } else if (key === "bucket") {
          bucketStore = decl && resourceByDecl.get(decl);
        }
      }
      if (!certOk) throw new Error(`${at}: the CDN's cert must be the app's Cert, passed as a variable`);
      if (!bucketStore) throw new Error(`${at}: the CDN's bucket must be a BlobStore variable declared in your project`);
      if (bucketStore.resource.provider !== "aws") throw new Error(`${at}: the CDN's bucket must use provider "aws"`);
      if (bucketStore.resource.dry) {
        warnings.push(`${at}: bucket "${bucketStore.resource.name}" is dry, but the CDN adds one statement to its bucket policy`);
      }

      const behaviors = routerCdn === undefined ? [] : cdnBehaviors(at);
      if (routerCdn !== undefined && initializerOf(routerCdn, "the router's cdn", where(router)) !== cdnExpr) {
        throw new Error(`${where(router)}: the router's cdn must be the app's CDN`);
      }
      if (routerCdn === undefined) {
        // The CDN only serves the bucket.
      } else {
        if (authenticated !== "iam") {
          throw new Error(`${where(router)}: a CDN reaches functions through CloudFront, which needs authenticated: "iam"`);
        }
        const options = router.getArguments()[1];
        if (hasOption(options, "authenticate")) {
          const open = [...publicRoutes].find(([, isPublic]) => !isPublic);
          if (open) {
            throw new Error(
              `${where(router)}: with a cdn, CloudFront calls functions directly and the router's authenticate hook does not run for "${open[0]}"; mark it { public: true } or drop the cdn`,
            );
          }
        }
        if (hasOption(options, "rateLimit")) {
          warnings.push(`${where(router)}: rateLimit does not apply to routes served through the CDN`);
        }
      }
      cdn = { provider: "aws", domain: domainName!, bucket: bucketStore.resource.name, path: bucketStore.path, behaviors };
    }
    return { dns, certificate, cdn };
  }

  // CloudFront picks a behavior by path only, so each pattern needs exactly one function.
  function cdnBehaviors(at: string) {
    const byPattern = new Map<string, { fn: AnalyzedFunction; methods: Set<string>; first: string }>();
    for (const fn of functions.values()) {
      for (const route of fn.routes) {
        const pattern = route.path.replace(/\{[^}]+\}/g, "*");
        const existing = byPattern.get(pattern);
        if (existing && existing.fn !== fn) {
          throw new Error(
            `${at}: CloudFront cannot route by method: ${existing.first} (${existing.fn.name}) and ${route.method} ${route.path} (${fn.name}) share the path "${pattern}"; give them different paths`,
          );
        }
        const entry = existing ?? { fn, methods: new Set<string>(), first: `${route.method} ${route.path}` };
        entry.methods.add(route.method);
        byPattern.set(pattern, entry);
      }
    }
    const wildcards = (pattern: string) => pattern.split("*").length - 1;
    return [...byPattern]
      .sort(([a], [b]) => wildcards(a) - wildcards(b) || b.length - a.length)
      .map(([pathPattern, { fn, methods }]) => ({ pathPattern, function: fn.name, methods: [...methods].sort() }));
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

function readRouteOptions(options: Node | undefined, at: string): { name?: string; public: boolean } {
  const result: { name?: string; public: boolean } = { public: false };
  if (!options) return result;
  if (!Node.isObjectLiteralExpression(options)) throw new Error(`${at}: route options must be an object literal`);
  for (const prop of options.getProperties()) {
    if (Node.isSpreadAssignment(prop)) throw new Error(`${at}: spread in route options cannot be analyzed`);
    const key = propName(prop);
    if (key === "name") {
      if (!Node.isPropertyAssignment(prop)) throw new Error(`${at}: route name must be a string literal`);
      const name = stringLiteral(prop.getInitializer(), `${at}: route name`);
      if (!name) throw new Error(`${at}: route name must not be empty`);
      result.name = name;
    } else if (key === "public") {
      const value = Node.isPropertyAssignment(prop) ? prop.getInitializer()?.getText() : undefined;
      if (value !== "true" && value !== "false") throw new Error(`${at}: route public must be the literal true or false`);
      result.public = value === "true";
    }
  }
  return result;
}

function readStringOption(options: Node | undefined, name: string, at: string): string | undefined {
  if (!options) return undefined;
  if (!Node.isObjectLiteralExpression(options)) throw new Error(`${at} must be an object literal`);
  for (const prop of options.getProperties()) {
    if (Node.isSpreadAssignment(prop)) throw new Error(`${at}: spread cannot be analyzed`);
    if (propName(prop) === name) {
      if (!Node.isPropertyAssignment(prop)) throw new Error(`${at}: ${name} must be a string literal`);
      return stringLiteral(prop.getInitializer(), `${at}: ${name}`);
    }
  }
  return undefined;
}

// The declaration a property's value refers to: `{ cert }` and `{ cert: cert }` alike.
function valueDeclaration(prop: Node): Node | undefined {
  if (Node.isShorthandPropertyAssignment(prop)) return resolveSymbol(prop.getValueSymbol())?.getDeclarations()[0];
  if (Node.isPropertyAssignment(prop)) {
    const init = prop.getInitializer();
    return init && Node.isIdentifier(init) ? resolveSymbol(init.getSymbol())?.getDeclarations()[0] : undefined;
  }
  return undefined;
}

function readCdnReference(options: Node | undefined, at: string): Node | undefined {
  if (!options || !Node.isObjectLiteralExpression(options)) return undefined;
  for (const prop of options.getProperties()) {
    if (propName(prop) !== "cdn") continue;
    const decl = valueDeclaration(prop);
    if (!decl) throw new Error(`${at}: the router's cdn must be a variable`);
    return Node.isVariableDeclaration(decl) ? decl.getNameNode() : decl;
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

