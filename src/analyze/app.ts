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
  // Declared region; undefined means the region the app is deployed to.
  region?: string;
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
  // Every route is `public`, so the function skips token verification.
  anonymous?: boolean;
}

// Settings of the router's `authenticate: jwtAuth({...})`, for functions that verify tokens themselves.
export interface JwtSettings {
  issuer: string;
  audience?: string | string[];
  jwksUri?: string;
  clockToleranceSeconds?: number;
  header: string;
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
  // Region of the functions, from the router's options; undefined means the deploy default.
  region?: string;
  authenticated: Authentication;
  // Set with a CDN, where viewers reach functions directly and each function verifies the token.
  jwt?: JwtSettings;
  entry: string;
  resources: AnalyzedResource[];
  functions: AnalyzedFunction[];
  warnings: string[];
}

const DIRECTIVE = /^cloudgear:\s*(.+)$/;
const KNOWN_DIRECTIVES = new Set(["dry"]);
const PERMISSIONS = { Get: "read", Put: "write", Delete: "delete", List: "list" } as const;
const permissionName = (access: BlobAccess) => `permissions.${Object.entries(PERMISSIONS).find(([, a]) => a === access)![0]}`;
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
    const storeRegion = readRegion(optionsArg, `${where(expr)}: BlobStore`);
    const decl = expr.getParentIfKind(SyntaxKind.VariableDeclaration);
    if (!decl || decl.getInitializer() !== expr) {
      throw new Error(`${where(expr)}: assign new BlobStore(...) to a variable so its usage can be traced`);
    }
    const resource: AnalyzedResource = {
      kind: "BlobStore",
      name: parseBlobUri(provider as BlobProvider, uri),
      provider,
      region: storeRegion,
      dry: readDirectives(decl, where(expr)).has("dry"),
      file: relative(expr.getSourceFile().getFilePath()),
      line: expr.getStartLineNumber(),
    };
    const existing = resources.get(resource.name);
    if (existing && (existing.dry !== resource.dry || existing.provider !== resource.provider || existing.region !== resource.region)) {
      throw new Error(
        `${where(expr)}: BlobStore "${resource.name}" is also declared at ${existing.file}:${existing.line} with a different provider, region or directives`,
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
  const routerRegion = readRegion(router.getArguments()[1], `${where(router)}: FunctionRouter`);
  if (authenticated === "none") {
    warnings.push(`${where(router)}: authenticated is "none"; deployed functions can be invoked by anyone with their URL`);
  }
  if (authenticated === "none" && hasOption(router.getArguments()[1], "authenticate")) {
    warnings.push(
      `${where(router)}: authenticate is set but authenticated is "none"; deployed functions will not receive the caller's identity`,
    );
  }
  const jwtSettings = readJwtAuth(router.getArguments()[1], where(router));
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
      const policies = readPolicies(fnNode, fn.name);
      for (const [key, allowed] of policies) {
        const tally = tallies.get(key);
        const extra = [...(tally ? [...tally.ops, ...tally.grants] : [])].filter((access) => !allowed.has(access));
        if (tally && extra.length) {
          throw new Error(
            `${where(decl)}: "${fn.name}" needs ${[...new Set(extra)].map((a) => permissionName(a)).join(", ")} on "${tally.store.resource.name}", which its @policy does not allow`,
          );
        }
      }
      for (const [key, tally] of tallies) {
        const policy = policies.get(key);
        if (policy) continue;
        let accesses = new Set([...tally.ops, ...tally.grants]);
        if (tally.widenedAt && tally.grants.size === 0) {
          accesses = new Set(ALL_ACCESS);
          warnings.push(
            `${where(tally.widenedAt)}: BlobStore "${tally.store.resource.name}" is passed around as a value; granting every operation on it (use grant(store, ...) to narrow)`,
          );
        }
        fn.uses.set(key, { resource: tally.store.resource.name, path: tally.store.path, accesses });
      }
      for (const [key, accesses] of policies) {
        const [resource, storePath] = key.split("\0") as [string, string];
        fn.uses.set(key, { resource, path: storePath, accesses });
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
  const verifying = !!jwtSettings && !!edge.cdn?.behaviors.length;
  if (verifying) {
    for (const fn of functions.values()) {
      const flags = fn.routes.map((r) => publicRoutes.get(`${r.method} ${r.path}`) ?? false);
      if (flags.some(Boolean) && !flags.every(Boolean)) {
        throw new Error(
          `${fn.file}: "${fn.name}" serves both public and protected routes; with a cdn a function verifies tokens as a whole, so give each its own function`,
        );
      }
      fn.anonymous = flags.every(Boolean);
    }
  }

  return {
    ...edge,
    jwt: verifying ? jwtSettings : undefined,
    provider,
    region: routerRegion,
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
        // `@policy(store, ...)` is read separately, and is not a use of the store.
        if (node.getFirstAncestorByKind(SyntaxKind.Decorator)) continue;
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

  function readJwtAuth(options: Node | undefined, at: string): JwtSettings | undefined {
    if (!options || !Node.isObjectLiteralExpression(options)) return undefined;
    const prop = options.getProperties().find((p) => propName(p) === "authenticate");
    const init = prop && Node.isPropertyAssignment(prop) ? prop.getInitializer() : undefined;
    if (!init || !Node.isCallExpression(init)) return undefined;
    const decl = resolveSymbol(init.getExpression().getSymbol())?.getDeclarations()[0];
    const isJwtAuth =
      !!decl && Node.isFunctionDeclaration(decl) && decl.getName() === "jwtAuth" && packages.nameOf(decl.getSourceFile().getFilePath()) === "@cloudgear/functions";
    if (!isJwtAuth) return undefined;
    const arg = init.getArguments()[0];
    const what = `${at}: jwtAuth`;
    if (!arg || !Node.isObjectLiteralExpression(arg)) throw new Error(`${what} options must be an object literal so cloudgear can read them`);
    const settings: JwtSettings = { issuer: "", header: "authorization" };
    for (const p of arg.getProperties()) {
      if (Node.isSpreadAssignment(p)) throw new Error(`${what}: spread in options cannot be analyzed`);
      const key = propName(p);
      const value = Node.isPropertyAssignment(p) ? p.getInitializer() : undefined;
      if (key === "issuer") settings.issuer = stringLiteral(value, `${what} issuer`);
      else if (key === "jwksUri") settings.jwksUri = stringLiteral(value, `${what} jwksUri`);
      else if (key === "header") settings.header = stringLiteral(value, `${what} header`).toLowerCase();
      else if (key === "audience") {
        settings.audience =
          value && Node.isArrayLiteralExpression(value)
            ? value.getElements().map((e) => stringLiteral(e, `${what} audience`))
            : stringLiteral(value, `${what} audience`);
      } else if (key === "clockToleranceSeconds") {
        if (!value || !Node.isNumericLiteral(value)) throw new Error(`${what} clockToleranceSeconds must be a number literal`);
        settings.clockToleranceSeconds = Number(value.getLiteralText());
      } else if (key !== undefined) {
        throw new Error(`${what}: unknown option "${key}"`);
      }
    }
    if (!settings.issuer) throw new Error(`${what} needs an issuer`);
    return settings;
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
      if (dns!.domain === dns!.zone) {
        throw new Error(`${at}: "${dns!.domain}" is the zone apex, which cannot be a CNAME; serve the site from a subdomain`);
      }
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
        if (hasOption(options, "authenticate") && jwtSettings) {
          if (jwtSettings.header === "authorization") {
            throw new Error(
              `${where(router)}: with a cdn, jwtAuth needs a header other than "authorization" (for example { header: "x-auth-token" }); CloudFront origin access control signs requests to functions with that header`,
            );
          }
        } else if (hasOption(options, "authenticate")) {
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
      for (const fn of functions.values()) {
        for (const use of fn.uses.values()) {
          const overlaps = use.path.startsWith(bucketStore.path) || bucketStore.path.startsWith(use.path);
          if (use.resource === bucketStore.resource.name && overlaps) {
            warnings.push(
              `${at}: "${fn.name}" also uses the CDN's bucket "${use.resource}"${use.path ? ` under "${use.path}"` : ""}; files there are public through the CDN`,
            );
          }
        }
      }
      cdn = { provider: "aws", domain: domainName!, bucket: bucketStore.resource.name, path: bucketStore.path, behaviors };
    }
    return { dns, certificate, cdn };
  }

  // CloudFront picks a behavior by path only, so each pattern needs exactly one function.
  function cdnBehaviors(at: string) {
    const assertSupported = (route: { method: string; path: string }, pattern: string) => {
      if (!/^[A-Za-z0-9_\-.*$/~"'@:+]+$/.test(pattern)) {
        throw new Error(`${at}: CloudFront path patterns allow only letters, digits and _ - . * $ / ~ " ' @ : +; ${route.method} ${route.path} does not qualify`);
      }
      const shadowed = SITE_PATHS.find((sitePath) => patternMatches(pattern, sitePath));
      if (shadowed) {
        throw new Error(
          `${at}: ${route.method} ${route.path} becomes "${pattern}", which would capture the static site's ${shadowed}; put it under a fixed prefix such as /api`,
        );
      }
    };
    const byPattern = new Map<string, { fn: AnalyzedFunction; methods: Set<string>; first: string }>();
    for (const fn of functions.values()) {
      for (const route of fn.routes) {
        const pattern = route.path.replace(/\{[^}]+\}/g, "*");
        assertSupported(route, pattern);
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
    if (byPattern.size > 25) {
      warnings.push(`${at}: ${byPattern.size} CloudFront behaviors exceed the default quota of 25 per distribution`);
    }
    return orderBySpecificity([...byPattern.keys()]).map((pathPattern) => {
      const { fn, methods } = byPattern.get(pathPattern)!;
      return { pathPattern, function: fn.name, methods: [...methods].sort() };
    });
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

  // Permissions a routed method declares with `@policy(store, { permissions: [...] })`, by store key.
  function readPolicies(fnNode: Node, fnName: string): Map<string, Set<BlobAccess>> {
    const result = new Map<string, Set<BlobAccess>>();
    if (!Node.isMethodDeclaration(fnNode)) return result;
    for (const decorator of fnNode.getDecorators()) {
      const call = decorator.getCallExpression();
      const callee = call?.getExpression();
      const decl = callee && Node.isIdentifier(callee) ? resolveSymbol(callee.getSymbol())?.getDeclarations()[0] : undefined;
      const isPolicy =
        !!decl && Node.isFunctionDeclaration(decl) && decl.getName() === "policy" && packages.nameOf(decl.getSourceFile().getFilePath()) === "@cloudgear/blob";
      if (!call || !isPolicy) continue;
      const at = where(decorator);
      const [storeArg, optionsArg] = call.getArguments();
      const storeDecl = storeArg && Node.isIdentifier(storeArg) ? resolveSymbol(storeArg.getSymbol())?.getDeclarations()[0] : undefined;
      const store = storeDecl && resourceByDecl.get(storeDecl);
      if (!store) throw new Error(`${at}: @policy needs a BlobStore variable declared in your project as its first argument`);
      const list =
        optionsArg && Node.isObjectLiteralExpression(optionsArg)
          ? optionsArg.getProperties().find((p) => propName(p) === "permissions")
          : undefined;
      const array = list && Node.isPropertyAssignment(list) ? list.getInitializer() : undefined;
      if (!array || !Node.isArrayLiteralExpression(array)) throw new Error(`${at}: @policy needs { permissions: [...] } as an array literal`);
      const accesses = new Set<BlobAccess>();
      for (const element of array.getElements()) accesses.add(readPermission(element, at));
      if (accesses.size === 0) throw new Error(`${at}: @policy for "${fnName}" lists no permissions`);
      const key = `${store.resource.name}\0${store.path}`;
      result.set(key, new Set([...(result.get(key) ?? []), ...accesses]));
    }
    return result;
  }

  function readPermission(element: Node, at: string): BlobAccess {
    if (Node.isPropertyAccessExpression(element)) {
      const root = element.getExpression();
      const decl = Node.isIdentifier(root) ? resolveSymbol(root.getSymbol())?.getDeclarations()[0] : undefined;
      const access = PERMISSIONS[element.getName() as keyof typeof PERMISSIONS];
      if (access && decl && packages.nameOf(decl.getSourceFile().getFilePath()) === "@cloudgear/blob") return access;
    } else if (Node.isStringLiteral(element) && ALL_ACCESS.includes(element.getLiteralValue() as BlobAccess)) {
      return element.getLiteralValue() as BlobAccess;
    }
    throw new Error(`${at}: @policy permissions must be permissions.Get/Put/Delete/List from @cloudgear/blob, got: ${element.getText()}`);
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

// "eu-west-1", "us-gov-east-1", "cn-north-1"
const REGION = /^[a-z]{2,5}(-[a-z]+)+-\d$/;

function readRegion(options: Node | undefined, at: string): string | undefined {
  const region = readStringOption(options, "region", `${at} options`);
  if (region !== undefined && !REGION.test(region)) throw new Error(`${at}: "${region}" is not an AWS region such as "eu-west-1"`);
  return region;
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
// CloudFront's `*` also matches "/", so "/users/*" would swallow "/users/*/posts/*". A pattern must
// come after every pattern that matches only a subset of its paths; otherwise fewer wildcards, then longer, first.
// Paths a static site normally serves; an API route must not capture them.
const SITE_PATHS = ["/", "/index.html", "/favicon.ico", "/assets/app.js", "/static/app.js"];

function patternMatches(pattern: string, path: string): boolean {
  const source = pattern.replace(/[.+$"'@:~-]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${source}$`).test(path);
}

export function orderBySpecificity(patterns: string[]): string[] {
  // Stand in for `*` with a character no pattern contains, so a literal never looks like a wildcard's match.
  const filler = ["#", "%", "!", "^", "\u0001"].find((c) => !patterns.some((p) => p.includes(c))) ?? "\u0002";
  const regexes = patterns.map((p) => new RegExp(`^${p.replace(/[.+$"'@:~-]/g, "\\$&").replace(/\*/g, ".*")}$`));
  const samples = patterns.map((p) => p.replace(/\*/g, filler));
  const narrower = (a: number, b: number) => a !== b && regexes[b]!.test(samples[a]!) && !regexes[a]!.test(samples[b]!);
  const narrow = patterns.map((_, a) => patterns.map((_, b) => narrower(a, b)));
  const wildcards = (pattern: string) => pattern.split("*").length - 1;

  const remaining = new Set(patterns.keys());
  const ordered: string[] = [];
  while (remaining.size) {
    const ready = [...remaining]
      .filter((p) => ![...remaining].some((q) => narrow[q]![p]))
      .sort((a, b) => wildcards(patterns[a]!) - wildcards(patterns[b]!) || patterns[b]!.length - patterns[a]!.length);
    const next = ready[0] ?? [...remaining][0]!;
    ordered.push(patterns[next]!);
    remaining.delete(next);
  }
  return ordered;
}

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
  if (Node.isMethodDeclaration(decl) && Node.isClassDeclaration(object)) {
    const exported = exportNameOf(object);
    return exported && decl.isStatic() && /^[A-Za-z_$][\w$]*$/.test(decl.getName()) ? { exportName: exported, member: decl.getName() } : undefined;
  }
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

