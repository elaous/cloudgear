import fs from "node:fs";
import path from "node:path";
import {
  Node,
  Project,
  SyntaxKind,
  type CallExpression,
  type ClassDeclaration,
  type NewExpression,
  type SourceFile,
  type Symbol as MorphSymbol,
  type VariableDeclaration,
} from "ts-morph";
import { assertPolicyDocument, assertPolicyName, broadStatements, type PolicyDocument } from "@cloudgear/iam";
import { scanEnvUse, type EnvUse } from "./envuse";
import { assertBusName, assertEventSource, assertEventType } from "@cloudgear/events";
import { BLOB_OPERATIONS, normalizeBlobPath, parseBlobUri, type BlobAccess, type BlobProvider } from "@cloudgear/blob";
import { DNS, isWildcardDomain, normalizeHostname, wildcardCovers } from "@cloudgear/dns";
import { parseSecretPath, type SecretService } from "@cloudgear/secrets";
import { METHODS, normalizeCron, toEventBridgeCron } from "@cloudgear/functions";
import { behaviorsFor, conflictingGroups } from "../routes";

export interface AnalyzedResource {
  kind: "BlobStore";
  name: string;
  provider: string;
  region?: string;
  dry: boolean;
  options?: Record<string, string>;
  file: string;
  line: number;
}

export interface SecretBindingModel {
  provider: "aws";
  service: SecretService;
  region?: string;
  kmsKey?: string;
  path: string;
  // Empty for a wildcard binding.
  name: string;
  env: string;
  all?: boolean;
}

export type SecretRefModel = Omit<SecretBindingModel, "env" | "all">;

// Name "default" means the account's default bus.
export interface AnalyzedBus {
  name: string;
  provider: "aws";
  file: string;
  line: number;
}

export interface EventTriggerModel {
  bus: string;
  type: string;
  source?: string;
}

export interface ScheduleModel {
  cron: string;
  query?: Record<string, string>;
}

// An inline IAM policy, its document as canonical JSON.
export interface PolicyModel {
  name: string;
  document: string;
}

export interface StoreUse {
  resource: string;
  path: string;
  accesses: Set<BlobAccess>;
}

export interface AnalyzedFunction {
  name: string;
  file: string;
  exportName: string;
  member?: string;
  declaredName: string;
  inputType?: string;
  routes: { method: string; path: string; name: string }[];
  // Keyed by resource and path, NUL-separated.
  uses: Map<string, StoreUse>;
  // Every route is public; the function skips token checks.
  anonymous?: boolean;
  options?: Record<string, string>;
  schedules: ScheduleModel[];
  secrets: SecretBindingModel[];
  envUse: EnvUse;
  // Inline policies put on the function's role.
  policies: PolicyModel[];
  events: EventTriggerModel[];
  publishes: string[];
  include: { rel: string; abs: string }[];
  passRequest: boolean;
  responseKind?: "helper" | "writer";
}

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

export interface CertificateModel {
  provider: string;
  domain: string;
  dns: { provider: string; domain: string; zone: string; token?: SecretRefModel };
  // Decides the region the certificate is issued in.
  usage: "cdn" | "api" | "";
  region?: string;
  options?: Record<string, string>;
}

export interface CdnModel {
  provider: string;
  domain: string;
  options?: Record<string, string>;
  certificate: string;
  bucket: string;
  path: string;
}

export interface EdgeModel {
  certificates: CertificateModel[];
  cdns: CdnModel[];
  api?: { provider: string; domain: string; certificate?: string; via?: "cloudfront"; method_routing?: boolean; options?: Record<string, string> };
}

export interface AppModel extends EdgeModel {
  provider: string;
  region?: string;
  authenticated: Authentication;
  jwt?: JwtSettings;
  entry: string;
  resources: AnalyzedResource[];
  optionalEnv: string[];
  buses: AnalyzedBus[];
  functions: AnalyzedFunction[];
  warnings: string[];
}

const QUERY_NAME = /^[A-Za-z0-9_.:/-]+$/;
const QUERY_VALUE = /^[A-Za-z0-9_.:/-]*$/;
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
  const isAppFile = (file: SourceFile) => !file.isDeclarationFile() && !file.isInNodeModules() && !packages.isCloudgear(file.getFilePath());
  const scanned = new Set<SourceFile>();
  for (let added = true; added; ) {
    added = false;
    for (const file of project.getSourceFiles().filter((f) => isAppFile(f) && !scanned.has(f))) {
      scanned.add(file);
      for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const script = scriptOf(call);
        if (script && !project.getSourceFile(script) && fs.existsSync(script)) {
          project.addSourceFileAtPath(script);
          project.resolveSourceFileDependencies();
          added = true;
        }
      }
    }
  }
  const localFiles = project.getSourceFiles().filter(isAppFile);
  const isLocal = (node: Node) => localFiles.includes(node.getSourceFile());

  const warnings: string[] = [];
  const where = (node: Node) => `${relative(node.getSourceFile().getFilePath())}:${node.getStartLineNumber()}`;
  const isClass = (expr: NewExpression, pkg: string, name: string) => {
    const decl = resolveSymbol(expr.getExpression().getSymbol())?.getDeclarations()[0];
    return !!decl && Node.isClassDeclaration(decl) && decl.getName() === name && packages.nameOf(decl.getSourceFile().getFilePath()) === pkg;
  };
  const newExpressions = localFiles.flatMap((file) => file.getDescendantsOfKind(SyntaxKind.NewExpression));

  const resourceByDecl = new Map<Node, Store>();
  const resources = new Map<string, AnalyzedResource>();
  for (const expr of newExpressions.filter((e) => isClass(e, "@cloudgear/blob", "BlobStore"))) {
    const [providerArg, uriArg, optionsArg] = expr.getArguments();
    const provider = stringLiteral(providerArg, `${where(expr)}: BlobStore provider`);
    const uri = stringLiteral(uriArg, `${where(expr)}: BlobStore URI`);
    const storePath = readStorePath(optionsArg, where(expr));
    const storeRegion = readRegion(optionsArg, `${where(expr)}: BlobStore`);
    const storeOptions = readOptionsMap(optionsArg, "options", `${where(expr)}: BlobStore`);
    const decl = expr.getParentIfKind(SyntaxKind.VariableDeclaration);
    if (!decl || decl.getInitializer() !== expr) {
      throw new Error(`${where(expr)}: assign new BlobStore(...) to a variable so its usage can be traced`);
    }
    const resource: AnalyzedResource = {
      kind: "BlobStore",
      name: parseBlobUri(provider as BlobProvider, uri),
      provider,
      region: storeRegion,
      options: storeOptions,
      dry: readDirectives(decl, where(expr)).has("dry"),
      file: relative(expr.getSourceFile().getFilePath()),
      line: expr.getStartLineNumber(),
    };
    const existing = resources.get(resource.name);
    if (existing && (existing.dry !== resource.dry || existing.provider !== resource.provider || existing.region !== resource.region || !sameOptions(existing.options, resource.options))) {
      throw new Error(
        `${where(expr)}: BlobStore "${resource.name}" is also declared at ${existing.file}:${existing.line} with a different provider, region, options or directives`,
      );
    }
    resources.set(resource.name, existing ?? resource);
    resourceByDecl.set(decl, { resource: existing ?? resource, path: storePath });
  }

  interface SecretStoreModel {
    provider: "aws";
    service: SecretService;
    region?: string;
    kmsKey?: string;
  }
  interface SecretPathModel {
    store: SecretStoreModel;
    prefix: string;
    all: boolean;
  }
  const secretStores = new Map<Node, SecretStoreModel>();
  for (const expr of newExpressions.filter((e) => isClass(e, "@cloudgear/secrets", "SecretStore"))) {
    const at = where(expr);
    const decl = expr.getParentIfKind(SyntaxKind.VariableDeclaration);
    if (!decl || decl.getInitializer() !== expr) throw new Error(`${at}: assign new SecretStore(...) to a variable so its paths can be traced`);
    const [providerArg, optionsArg] = expr.getArguments();
    if (stringLiteral(providerArg, `${at}: SecretStore provider`) !== "aws") throw new Error(`${at}: SecretStore provider must be "aws"`);
    const service = readStringOption(optionsArg, "service", `${at}: SecretStore options`) ?? "ssm";
    if (service !== "ssm" && service !== "secretsmanager") throw new Error(`${at}: SecretStore service must be "ssm" or "secretsmanager"`);
    secretStores.set(decl, {
      provider: "aws",
      service,
      region: readRegion(optionsArg, `${at}: SecretStore`),
      kmsKey: readStringOption(optionsArg, "kmsKey", `${at}: SecretStore options`),
    });
  }
  let secretUses: SecretBindingModel[] | undefined;

  const busDecls = new Map<Node, AnalyzedBus>();
  for (const expr of newExpressions.filter((e) => isClass(e, "@cloudgear/events", "EventBus"))) {
    const at = where(expr);
    const decl = expr.getParentIfKind(SyntaxKind.VariableDeclaration);
    if (!decl || decl.getInitializer() !== expr) throw new Error(`${at}: assign new EventBus(...) to a variable so its triggers and publishes can be traced`);
    const [providerArg, optionsArg] = expr.getArguments();
    if (stringLiteral(providerArg, `${at}: EventBus provider`) !== "aws") throw new Error(`${at}: EventBus provider must be "aws"`);
    const busName = readStringOption(optionsArg, "name", `${at}: EventBus options`);
    try {
      if (busName !== undefined) assertBusName(busName);
    } catch (err) {
      throw new Error(`${at}: ${(err as Error).message}`);
    }
    const declared = [...busDecls.values()].find((b) => b.name === (busName ?? "default"));
    if (declared) throw new Error(`${at}: EventBus "${declared.name}" is also declared at ${declared.file}:${declared.line}; declare each bus once and import it`);
    busDecls.set(decl, {
      name: busName ?? "default",
      provider: "aws",
      file: relative(expr.getSourceFile().getFilePath()),
      line: expr.getStartLineNumber(),
    });
  }
  const usedBuses = new Map<string, AnalyzedBus>();
  const useBus = (bus: AnalyzedBus, _at: string) => {
    if (!usedBuses.has(bus.name)) usedBuses.set(bus.name, bus);
  };
  let publishUses: Set<string> | undefined;

  const policyDecls = new Map<Node, PolicyModel>();
  const policyNames = new Map<string, string>();
  for (const expr of newExpressions.filter((e) => isClass(e, "@cloudgear/iam", "Policy"))) {
    const at = where(expr);
    const decl = expr.getParentIfKind(SyntaxKind.VariableDeclaration);
    if (!decl || decl.getInitializer() !== expr) throw new Error(`${at}: assign new Policy(...) to a variable so it can be attached`);
    const [providerArg, optionsArg] = expr.getArguments();
    if (stringLiteral(providerArg, `${at}: Policy provider`) !== "aws") throw new Error(`${at}: Policy provider must be "aws"`);
    if (!optionsArg || !Node.isObjectLiteralExpression(optionsArg)) throw new Error(`${at}: Policy options must be an object literal with a name and a document`);
    const name = readStringOption(optionsArg, "name", `${at}: Policy options`);
    if (!name) throw new Error(`${at}: a Policy needs a name`);
    const documentProp = optionsArg.getProperties().find((p) => !Node.isSpreadAssignment(p) && propName(p) === "document");
    if (!documentProp) throw new Error(`${at}: a Policy needs a document`);
    const documentNode = Node.isPropertyAssignment(documentProp) ? documentProp.getInitializer() : Node.isShorthandPropertyAssignment(documentProp) ? documentProp.getNameNode() : undefined;
    try {
      assertPolicyName(name);
      const document = readPolicyDocument(documentNode, at);
      assertPolicyDocument(document, name);
      const earlier = policyNames.get(name);
      if (earlier) throw new Error(`a policy named "${name}" is also declared at ${earlier}`);
      policyNames.set(name, at);
      policyDecls.set(decl, { name, document: JSON.stringify(sortKeys(document)) });
      for (const finding of broadStatements(document)) warnings.push(`${at}: policy "${name}": ${finding}`);
    } catch (err) {
      const message = (err as Error).message;
      throw new Error(message.startsWith(at) ? message : `${at}: ${message}`);
    }
  }

  // The policy's document: an object literal, or the default import of a .json file next to the code.
  function readPolicyDocument(node: Node | undefined, at: string): PolicyDocument {
    if (node && Node.isObjectLiteralExpression(node)) return literalToJson(node, at) as PolicyDocument;
    if (node && Node.isIdentifier(node)) {
      // The import itself (not what it resolves to): `import document from "./x.json"`.
      const decl = node.getSymbol()?.getDeclarations()[0];
      // Only the default import: a named one would be a part of the file, not the document.
      const importDecl = decl && Node.isImportClause(decl) ? decl.getFirstAncestorByKind(SyntaxKind.ImportDeclaration) : undefined;
      const specifier = importDecl?.getModuleSpecifierValue();
      if (importDecl && specifier?.endsWith(".json") && specifier.startsWith(".")) {
        const file = path.resolve(path.dirname(importDecl.getSourceFile().getFilePath()), specifier);
        try {
          return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as PolicyDocument;
        } catch (err) {
          throw new Error(`${at}: ${relative(file)} could not be read as JSON (${(err as Error).message})`);
        }
      }
    }
    throw new Error(`${at}: a policy document must be an object literal or a default import of a .json file (import document from "./policies/x.json")`);
  }

  function literalToJson(node: Node, at: string): unknown {
    if (Node.isObjectLiteralExpression(node)) {
      const out: Record<string, unknown> = {};
      for (const prop of node.getProperties()) {
        if (!Node.isPropertyAssignment(prop)) throw new Error(`${at}: a policy document cannot use spreads, shorthands or methods`);
        const key = propName(prop);
        if (!key) throw new Error(`${at}: a policy document's keys must be plain names or strings`);
        out[key] = literalToJson(prop.getInitializerOrThrow(), at);
      }
      return out;
    }
    if (Node.isArrayLiteralExpression(node)) return node.getElements().map((item) => literalToJson(item, at));
    if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) return node.getLiteralValue();
    if (Node.isNumericLiteral(node)) return node.getLiteralValue();
    if (Node.isPrefixUnaryExpression(node) && node.getOperatorToken() === SyntaxKind.MinusToken && Node.isNumericLiteral(node.getOperand())) return -(node.getOperand() as import("ts-morph").NumericLiteral).getLiteralValue();
    if (node.getKind() === SyntaxKind.TrueKeyword) return true;
    if (node.getKind() === SyntaxKind.FalseKeyword) return false;
    if (node.getKind() === SyntaxKind.NullKeyword) return null;
    if (Node.isParenthesizedExpression(node) || Node.isAsExpression(node) || Node.isSatisfiesExpression(node)) return literalToJson(node.getExpression(), at);
    throw new Error(`${at}: a policy document can only hold literals, got: ${node.getText()}`);
  }

  function sortKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, sortKeys(v)]));
    return value;
  }

  // `policies: policy` or `policies: [a, b]` on a route or the router.
  function readPolicyOption(options: Node | undefined, at: string): PolicyModel[] {
    if (!options || !Node.isObjectLiteralExpression(options)) return [];
    const prop = options.getProperties().find((p) => !Node.isSpreadAssignment(p) && propName(p) === "policies");
    if (!prop) return [];
    const shorthand = Node.isShorthandPropertyAssignment(prop) ? prop.getNameNode() : undefined;
    const value = Node.isPropertyAssignment(prop) ? prop.getInitializer() : shorthand;
    const nodes = value && Node.isArrayLiteralExpression(value) ? value.getElements() : [value];
    return nodes.map((item) => {
      const decl = item && Node.isIdentifier(item) ? resolveSymbol(item.getSymbol())?.getDeclarations()[0] ?? (Node.isShorthandPropertyAssignment(prop) ? resolveSymbol(prop.getValueSymbol())?.getDeclarations()[0] : undefined) : undefined;
      const model = decl && policyDecls.get(decl);
      if (!model) throw new Error(`${at}: policies must be Policy variables declared in your project, got: ${item?.getText() ?? "nothing"}`);
      return model;
    });
  }

  const uniquePolicies = (items: PolicyModel[]): PolicyModel[] => [...new Map(items.map((p) => [p.name, p])).values()];

  const busOf = (node: Node | undefined): AnalyzedBus | undefined => {
    for (let current = node, depth = 0; current && Node.isIdentifier(current) && depth < 8; depth++) {
      const decl = resolveSymbol(current.getSymbol())?.getDeclarations()[0];
      if (!decl) return undefined;
      const bus = busDecls.get(decl);
      if (bus) return bus;
      current = Node.isVariableDeclaration(decl) ? decl.getInitializer() : undefined;
    }
    return undefined;
  };

  function triggerOf(node: Node | undefined, at: string): EventTriggerModel {
    const e = initOf(node);
    const callee = e && Node.isCallExpression(e) ? e.getExpression() : undefined;
    const bus = callee && Node.isPropertyAccessExpression(callee) && callee.getName() === "event" ? busOf(callee.getExpression()) : undefined;
    if (!e || !Node.isCallExpression(e) || !bus) {
      throw new Error(`${at}: an event trigger must be bus.event("type") on an EventBus variable declared in your project, got: ${node?.getText() ?? "nothing"}`);
    }
    const arg = initOf(e.getArguments()[0]);
    let type: string;
    let source: string | undefined;
    if (arg && Node.isObjectLiteralExpression(arg)) {
      type = readStringOption(arg, "type", `${at}: event`) ?? "";
      source = readStringOption(arg, "source", `${at}: event`);
      if (!type) throw new Error(`${at}: an event needs a type`);
    } else {
      type = stringLiteral(arg, `${at}: event type`);
    }
    try {
      assertEventType(type);
      if (source !== undefined) assertEventSource(source);
    } catch (err) {
      throw new Error(`${at}: ${(err as Error).message}`);
    }
    useBus(bus, at);
    return { bus: bus.name, type, ...(source !== undefined ? { source } : {}) };
  }

  function triggersOf(node: Node | undefined, at: string): EventTriggerModel[] {
    const e = initOf(node);
    const nodes = e && Node.isArrayLiteralExpression(e) ? e.getElements() : [node];
    return nodes.map((item) => triggerOf(item, at));
  }

  function readEventOption(options: Node | undefined, at: string): EventTriggerModel[] {
    if (!options || !Node.isObjectLiteralExpression(options)) return [];
    const prop = options.getProperties().find((p) => !Node.isSpreadAssignment(p) && propName(p) === "on");
    if (!prop) return [];
    const shorthand = Node.isShorthandPropertyAssignment(prop) ? resolveSymbol(prop.getValueSymbol())?.getDeclarations()[0] : undefined;
    const value = Node.isPropertyAssignment(prop) ? prop.getInitializer() : shorthand && Node.isVariableDeclaration(shorthand) ? shorthand.getInitializer() : undefined;
    return triggersOf(value, at);
  }

  function addEvents(fn: AnalyzedFunction, events: EventTriggerModel[]) {
    for (const event of events) if (!fn.events.some((e) => JSON.stringify(e) === JSON.stringify(event))) fn.events.push(event);
  }

  // Bus passed as a value is untraced; no permission inferred.
  function noteBusValue(node: Node, decl: Node) {
    if (!publishUses || !busDecls.has(decl)) return;
    const parent = node.getParent();
    const member = Node.isPropertyAccessExpression(parent) && parent.getExpression() === node ? parent.getName() : undefined;
    if (member === "event" || member === "publish") return;
    if (Node.isVariableDeclaration(parent) && parent.getNameNode() === node) return;
    warnings.push(`${where(node)}: EventBus "${busDecls.get(decl)!.name}" is used as a value; publishes made through it are not traced, so call bus.publish on the variable`);
  }

  function noteBusCall(call: CallExpression) {
    if (!publishUses) return;
    const callee = call.getExpression();
    if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== "publish") return;
    const bus = busOf(callee.getExpression());
    if (!bus) return;
    useBus(bus, where(call));
    publishUses.add(bus.name);
  }

  function isOnDecorator(decorator: Node): boolean {
    if (!Node.isDecorator(decorator)) return false;
    const callee = decorator.getCallExpression()?.getExpression();
    const decl = callee && Node.isIdentifier(callee) ? resolveSymbol(callee.getSymbol())?.getDeclarations()[0] : undefined;
    return !!decl && Node.isFunctionDeclaration(decl) && decl.getName() === "on" && packages.nameOf(decl.getSourceFile().getFilePath()) === "@cloudgear/events";
  }

  function findEventMethods(): { node: Node; label: string; events: EventTriggerModel[] }[] {
    const found: { node: Node; label: string; events: EventTriggerModel[] }[] = [];
    for (const file of localFiles) {
      for (const method of file.getDescendantsOfKind(SyntaxKind.MethodDeclaration)) {
        const decorators = method.getDecorators().filter(isOnDecorator);
        if (!decorators.length) continue;
        if (!Node.isClassDeclaration(method.getParent())) throw new Error(`${where(method)}: @on applies to a method of a class declaration`);
        const events = decorators.flatMap((decorator) => triggersOf(decorator.getCallExpression()?.getArguments()[0], `${where(decorator)}: @on`));
        found.push({ node: method, label: method.getName(), events });
      }
    }
    return found;
  }

  const initOf = (node: Node | undefined, depth = 0): Node | undefined => {
    if (!node) return undefined;
    if (Node.isParenthesizedExpression(node) || Node.isAsExpression(node) || Node.isNonNullExpression(node)) return initOf(node.getExpression(), depth);
    if (Node.isIdentifier(node) && depth < 8) {
      const decl = resolveSymbol(node.getSymbol())?.getDeclarations()[0];
      const init = decl && Node.isVariableDeclaration(decl) ? decl.getInitializer() : undefined;
      return init ? initOf(init, depth + 1) : node;
    }
    return node;
  };

  const pathOf = (node: Node | undefined): SecretPathModel | undefined => {
    const e = initOf(node);
    if (!e || !Node.isCallExpression(e)) return undefined;
    const callee = e.getExpression();
    if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== "path") return undefined;
    const owner = callee.getExpression();
    const ownerDecl = Node.isIdentifier(owner) ? resolveSymbol(owner.getSymbol())?.getDeclarations()[0] : undefined;
    const store = ownerDecl && secretStores.get(ownerDecl);
    if (!store) return undefined;
    const text = stringLiteral(e.getArguments()[0], `${where(e)}: SecretStore path`);
    try {
      return { store, ...(({ prefix, all }) => ({ prefix, all }))(parseSecretPath(text)) };
    } catch (err) {
      throw new Error(`${where(e)}: ${(err as Error).message}`);
    }
  };

  const callOnPath = (node: Node | undefined): { path: SecretPathModel; arg: Node | undefined; call: CallExpression } | undefined => {
    const e = initOf(node);
    if (!e || !Node.isCallExpression(e)) return undefined;
    const path = pathOf(e.getExpression());
    return path ? { path, arg: e.getArguments()[0], call: e } : undefined;
  };

  const bindingFields = (path: SecretPathModel) => ({
    provider: path.store.provider,
    service: path.store.service,
    ...(path.store.region ? { region: path.store.region } : {}),
    ...(path.store.kmsKey ? { kmsKey: path.store.kmsKey } : {}),
    path: path.prefix,
  });

  const namesOf = (arg: Node | undefined, at: string): [string, string][] => {
    const e = initOf(arg);
    if (e && Node.isArrayLiteralExpression(e)) {
      return e.getElements().map((item): [string, string] => {
        const name = stringLiteral(item, `${at}: secret name`);
        return [name, name];
      });
    }
    if (e && Node.isObjectLiteralExpression(e)) {
      return e.getProperties().map((prop): [string, string] => {
        if (Node.isSpreadAssignment(prop)) throw new Error(`${at}: spread in a secret map cannot be analyzed`);
        const key = propName(prop);
        const value = Node.isPropertyAssignment(prop) ? prop.getInitializer() : undefined;
        if (!key) throw new Error(`${at}: secret map entries must be NAME: "secret-name"`);
        return [key, stringLiteral(value, `${at}: secret ${key}`)];
      });
    }
    throw new Error(`${at}: expected an array of names or a map of environment variable to secret name, got: ${arg?.getText() ?? "nothing"}`);
  };

  const uniqueSecrets = (items: SecretBindingModel[]): SecretBindingModel[] => {
    const seen = new Map<string, SecretBindingModel>();
    for (const item of items) seen.set(JSON.stringify([item.service, item.region, item.path, item.name, item.env, !!item.all]), item);
    return [...seen.values()];
  };

  function bindingsOf(node: Node, at: string): SecretBindingModel[] {
    const e = initOf(node);
    if (!e) return [];
    if (Node.isArrayLiteralExpression(e)) return e.getElements().flatMap((item) => bindingsOf(item, at));
    const whole = pathOf(e);
    if (whole) {
      if (!whole.all) throw new Error(`${at}: env needs the names to read, ${e.getText()}(["NAME"]), or a path ending in /* for everything under it`);
      return [{ ...bindingFields(whole), name: "", env: "", all: true }];
    }
    const call = callOnPath(e);
    if (!call) throw new Error(`${at}: env must be built from a SecretStore path, for example ss.path("/app")(["NAME"]); got: ${node.getText()}`);
    const arg = initOf(call.arg);
    if (arg && (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg))) {
      throw new Error(`${at}: a single secret is read in code with env("NAME").get(); an env binding takes a list or a map`);
    }
    return namesOf(call.arg, at).map(([env, name]) => ({ ...bindingFields(call.path), name, env }));
  }

  // Reading a secret by name needs access; env is not filled.
  function noteSecretCall(call: CallExpression) {
    if (!secretUses) return;
    const found = callOnPath(call);
    const arg = initOf(found?.arg);
    if (found && arg && (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg))) {
      secretUses.push({ ...bindingFields(found.path), name: arg.getLiteralValue(), env: "" });
    }
  }

  function noteSecretRef(decl: Node) {
    if (!secretUses || !Node.isVariableDeclaration(decl)) return;
    const ref = refOf(decl.getInitializer());
    if (ref) secretUses.push({ ...ref, env: "" });
  }

  function refOf(node: Node | undefined): SecretRefModel | undefined {
    const found = callOnPath(node);
    const arg = initOf(found?.arg);
    if (!found || !arg || !(Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg))) return undefined;
    return { ...bindingFields(found.path), name: arg.getLiteralValue() };
  }

  // Read from a secret at apply time; never a literal.
  function readSecretToken(options: Node | undefined, at: string): SecretRefModel | undefined {
    if (!options || !Node.isObjectLiteralExpression(options)) return undefined;
    const prop = options.getProperties().find((p) => !Node.isSpreadAssignment(p) && propName(p) === "token");
    if (!prop) return undefined;
    const value = Node.isPropertyAssignment(prop) ? prop.getInitializer() : undefined;
    const ref = refOf(value);
    if (!ref) {
      throw new Error(`${at}: the DNS token must be a secret, for example token: ss.path("/app")("GANDI_TOKEN"); a literal would be committed with the code`);
    }
    return ref;
  }

  function readEnvOption(options: Node | undefined, at: string): SecretBindingModel[] {
    if (!options || !Node.isObjectLiteralExpression(options)) return [];
    const prop = options.getProperties().find((p) => !Node.isSpreadAssignment(p) && propName(p) === "env");
    if (!prop) return [];
    const shorthand = Node.isShorthandPropertyAssignment(prop) ? resolveSymbol(prop.getValueSymbol())?.getDeclarations()[0] : undefined;
    const value = Node.isPropertyAssignment(prop) ? prop.getInitializer() : shorthand && Node.isVariableDeclaration(shorthand) ? shorthand.getInitializer() : undefined;
    return value ? bindingsOf(value, at) : [];
  }

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
  const routerSecrets = readEnvOption(router.getArguments()[1], `${where(router)}: FunctionRouter`);
  const routerPolicies = readPolicyOption(router.getArguments()[1], `${where(router)}: FunctionRouter`);
  const routerFunctionOptions = readOptionsMap(router.getArguments()[1], "functionOptions", `${where(router)}: FunctionRouter`);
  const routeOptionsOf = new Map<AnalyzedFunction, { options?: Record<string, string>; at: string }>();
  const extrasOf = new Map<AnalyzedFunction, { key: string; at: string }>();
  const responseKindOf = (prop: Node): "helper" | "writer" | undefined => {
    const decl = valueDeclaration(prop);
    if (!decl || packages.nameOf(decl.getSourceFile().getFilePath()) !== "@cloudgear/functions") return undefined;
    if (Node.isFunctionDeclaration(decl) && decl.getName() === "response") return "helper";
    return Node.isClassDeclaration(decl) && decl.getName() === "VercelResponse" ? "writer" : undefined;
  };
  const routeNames = new Map<string, string>();
  const publicRoutes = new Map<string, boolean>();

  const functions = new Map<Node, AnalyzedFunction>();
  const functionNodes = new Map<AnalyzedFunction, Node>();
  const isCdnRouterOption = (node: Node) => {
    if (!Node.isShorthandPropertyAssignment(node) && !Node.isPropertyAssignment(node)) return false;
    if (propName(node) !== "router") return false;
    const created = node.getParent()?.getParent();
    return !!created && Node.isNewExpression(created) && isClass(created, "@cloudgear/cdn", "CDN");
  };
  const addCalls = collectAddCalls(router, where, isCdnRouterOption);
  const scheduledMethods = findScheduledMethods();
  const eventMethods = findEventMethods();
  if (addCalls.length === 0 && scheduledMethods.length === 0 && eventMethods.length === 0) {
    throw new Error(`${where(router)}: FunctionRouter has no .url(...) routes`);
  }
  for (const call of addCalls) {
    const [methodArg, pathArg, fnArg] = call.getArguments();
    const method = stringLiteral(methodArg, `${where(call)}: route method`).toUpperCase();
    if (!(METHODS as readonly string[]).includes(method)) throw new Error(`${where(call)}: unsupported HTTP method "${method}"`);
    const routePath = stringLiteral(pathArg, `${where(call)}: route path`);
    if (!fnArg) throw new Error(`${where(call)}: missing function argument`);

    const scriptFile = scriptOf(call);
    const scriptText = Node.isStringLiteral(fnArg) || Node.isNoSubstitutionTemplateLiteral(fnArg) ? fnArg.getLiteralText() : undefined;
    let decl: Node | undefined;
    if (scriptText !== undefined) {
      const file = scriptFile && project.getSourceFile(scriptFile);
      if (!file) throw new Error(`${where(call)}: script "${scriptText}" not found; "./x" is relative to this file, any other path to the project root`);
      decl = file.getExportedDeclarations().get("default")?.[0];
    } else {
      decl = resolveSymbol(fnArg.getSymbol())?.getDeclarations()[0];
    }
    const fnNode = decl && (functionNode(decl) ?? (scriptText !== undefined && (Node.isArrowFunction(decl) || Node.isFunctionExpression(decl)) ? decl : undefined));
    if (!decl || !fnNode || !isLocal(decl)) {
      throw new Error(
        scriptText !== undefined
          ? `${where(call)}: script "${scriptText}" must export a function as its default export`
          : `${where(call)}: "${fnArg.getText()}" must reference a named function declared in your project`,
      );
    }
    const routeOptions = readRouteOptions(call.getArguments()[3], where(call), call.getSourceFile().getFilePath(), responseKindOf);
    const fn = functionFor(decl, fnNode, fnArg.getText(), Node.isPropertyAccessExpression(fnArg) ? fnArg.getExpression() : undefined, scriptFile && scriptNameOf(scriptFile, call.getSourceFile().getFilePath()), !routeOptions.request);
    if (fn.routes.some((r) => r.method === method && r.path === routePath)) {
      throw new Error(`${where(call)}: route "${method} ${routePath}" is registered twice`);
    }
    const extras = JSON.stringify([routeOptions.include.map((f) => f.rel), routeOptions.request, routeOptions.response]);
    const earlierExtras = extrasOf.get(fn);
    if (earlierExtras && earlierExtras.key !== extras) {
      throw new Error(`${where(call)}: the routes of "${fn.name}" give it different include, request or response settings (${earlierExtras.at}); set them identically`);
    }
    extrasOf.set(fn, earlierExtras ?? { key: extras, at: where(call) });
    fn.include = routeOptions.include;
    fn.passRequest = routeOptions.request;
    fn.responseKind = routeOptions.response;
    if (!routeOptions.request) checkPathParams(routePath, fnNode, where(call));
    publicRoutes.set(`${method} ${routePath}`, routeOptions.public);
    const routeName = routeOptions.name ?? ((scriptFile ? "" : fn.declaredName) || `${method} ${routePath}`);
    const clashing = routeNames.get(routeName);
    if (clashing) throw new Error(`${where(call)}: route name "${routeName}" is already used by ${clashing}; pass { name } to tell them apart`);
    routeNames.set(routeName, `${method} ${routePath}`);
    fn.routes.push({ method, path: routePath, name: routeName });
    addSchedules(fn, readScheduleOption(call.getArguments()[3], `${where(call)}: route`));
    addEvents(fn, readEventOption(call.getArguments()[3], `${where(call)}: route`));
    fn.secrets = uniqueSecrets([...fn.secrets, ...readEnvOption(call.getArguments()[3], `${where(call)}: route`)]);
    fn.policies = uniquePolicies([...fn.policies, ...readPolicyOption(call.getArguments()[3], `${where(call)}: route`)]);
    const routeFunctionOptions = readOptionsMap(call.getArguments()[3], "options", `${where(call)}: route`);
    const earlier = routeOptionsOf.get(fn);
    if (earlier && !sameOptions(earlier.options, routeFunctionOptions)) {
      throw new Error(`${where(call)}: the routes of "${fn.name}" give it different options (${earlier.at}); set them identically or use functionOptions`);
    }
    routeOptionsOf.set(fn, earlier ?? { options: routeFunctionOptions, at: where(call) });
    fn.options = routeFunctionOptions;
  }

  for (const method of scheduledMethods) {
    const fnNode = functionNode(method.node)!;
    const fn = functionFor(method.node, fnNode, method.label);
    addSchedules(fn, method.schedules);
  }
  for (const method of eventMethods) {
    const fnNode = functionNode(method.node)!;
    addEvents(functionFor(method.node, fnNode, method.label), method.events);
  }

  for (const fn of functions.values()) {
    fn.secrets = uniqueSecrets([...routerSecrets, ...fn.secrets]);
    fn.policies = uniquePolicies([...routerPolicies, ...fn.policies]);
    const merged = { ...routerFunctionOptions, ...fn.options };
    fn.options = Object.keys(merged).length ? merged : undefined;
  }

  for (const [fn, node] of functionNodes) fn.envUse = scanEnvUse(node, isAppFile, relative);

  const byName = new Map<string, AnalyzedFunction>();
  for (const fn of functions.values()) {
    const clash = byName.get(fn.name);
    if (clash) throw new Error(`Two functions are named "${fn.name}" (${clash.file}, ${fn.file}); rename one`);
    byName.set(fn.name, fn);
  }

  warnModuleLevelUse();
  const edge = analyzeEdge();
  const verifying = !!jwtSettings && !!edge.api;
  if (verifying) {
    for (const fn of functions.values()) {
      const flags = fn.routes.map((r) => publicRoutes.get(`${r.method} ${r.path}`) ?? false);
      if (flags.some(Boolean) && !flags.every(Boolean)) {
        throw new Error(
          `${fn.file}: "${fn.name}" serves both public and protected routes; with a cert or a CDN on the router a function verifies tokens as a whole, so give each its own function`,
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
    optionalEnv: readOptionalEnv(router.getArguments()[1], `${where(router)}: FunctionRouter`),
    buses: [...usedBuses.values()],
    functions: [...functions.values()],
    warnings: [...new Set(warnings)],
  };

  function collectUsage(root: Node, tallies: Map<string, Tally>, visited: Set<Node>) {
    visited.add(root);
    const trace = (target: Node) => {
      if (!visited.has(target)) collectUsage(target, tallies, visited);
    };
    const visit = (node: Node) => {
      if (Node.isCallExpression(node)) {
        noteSecretCall(node);
        noteBusCall(node);
      }
      if (!Node.isIdentifier(node)) return;
      for (const decl of declarationsOf(node)) {
        if (Node.isVariableDeclaration(decl) && decl.getNameNode() === node) continue;
        noteSecretRef(decl);
        noteBusValue(node, decl);
        // `@policy(...)` is not a use of the store.
        const decorator = node.getFirstAncestorByKind(SyntaxKind.Decorator);
        if (decorator && isPolicyDecorator(decorator)) continue;
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
    const routerCert = readCertReference(router.getArguments()[1], where(router));
    const routerOptions = router.getArguments()[1];

    if (!certExprs.length && !cdnExprs.length) {
      if (routerCert) throw new Error(`${where(router)}: the router's cert needs a Cert declared with new Cert(...)`);
      return { certificates: [], cdns: [] };
    }
    const servesRouter = (expr: NewExpression) => {
      const options = expr.getArguments()[2];
      return !!options && Node.isObjectLiteralExpression(options) && options.getProperties().some((prop) => !Node.isSpreadAssignment(prop) && propName(prop) === "router");
    };
    const siteCdnExprs = cdnExprs.filter((expr) => !servesRouter(expr));
    const routerCdnExprs = cdnExprs.filter(servesRouter);
    if (routerCdnExprs.length > 1) throw new Error(`Only one CDN per app can serve the router, found: ${routerCdnExprs.map(where).join(", ")}`);

    const initializerOf = (node: Node | undefined, what: string, at: string): NewExpression => {
      const decl = node && Node.isIdentifier(node) ? resolveSymbol(node.getSymbol())?.getDeclarations()[0] : undefined;
      const init = decl && Node.isVariableDeclaration(decl) ? decl.getInitializer() : undefined;
      if (!init || !Node.isNewExpression(init)) throw new Error(`${at}: ${what} must be a variable initialized with new ...(...)`);
      return init;
    };

    const dnsOf = (expr: NewExpression) => {
      const at = where(expr);
      const [providerArg, domainArg, optionsArg] = expr.getArguments();
      const provider = stringLiteral(providerArg, `${at}: DNS provider`);
      if (provider !== "gandi" && provider !== "aws") throw new Error(`${at}: DNS provider must be "gandi" or "aws"`);
      const zone = readStringOption(optionsArg, "zone", `${at}: DNS options`);
      const token = readSecretToken(optionsArg, at);
      try {
        const parsed = new DNS(provider, stringLiteral(domainArg, `${at}: DNS domain`), zone ? { zone } : {});
        return { provider, domain: parsed.domain, zone: parsed.zone, ...(token ? { token } : {}) };
      } catch (err) {
        throw new Error(`${at}: ${(err as Error).message}`);
      }
    };

    const certificates = new Map<NewExpression, CertificateModel>();
    for (const certExpr of certExprs) {
      const at = where(certExpr);
      const [providerArg, dnsArg, optionsArg] = certExpr.getArguments();
      if (stringLiteral(providerArg, `${at}: Cert provider`) !== "aws") throw new Error(`${at}: Cert provider must be "aws"`);
      const dnsExpr = initializerOf(dnsArg, "the Cert's DNS", at);
      if (!dnsExprs.includes(dnsExpr)) throw new Error(`${at}: the Cert's DNS must be a new DNS(...) declared in your project`);
      const dns = dnsOf(dnsExpr);
      const region = readRegion(optionsArg, `${at}: Cert`);
      const clash = [...certificates.values()].find((c) => c.domain === dns.domain);
      if (clash) throw new Error(`${at}: a certificate for "${dns.domain}" is already declared`);
      certificates.set(certExpr, { provider: "aws", domain: dns.domain, dns, usage: "", region, options: readOptionsMap(optionsArg, "options", `${at}: Cert`) });
    }

    const certOf = (node: Node | undefined, what: string, at: string): CertificateModel => {
      const model = certificates.get(initializerOf(node, what, at));
      if (!model) throw new Error(`${at}: ${what} must be a Cert declared in your project`);
      return model;
    };
    const subdomain = (domain: string, cert: CertificateModel, at: string, what: string) => {
      if (domain === cert.dns.zone) {
        throw new Error(`${at}: "${domain}" is the zone apex, which cannot be a CNAME; serve ${what} from a subdomain`);
      }
    };
    const servedHost = (cert: CertificateModel, optionsArg: Node | undefined, at: string): string => {
      const given = readStringOption(optionsArg, "domain", `${at}: CDN options`);
      let host: string;
      try {
        host = given === undefined ? cert.domain : normalizeHostname(given);
      } catch (err) {
        throw new Error(`${at}: ${(err as Error).message}`);
      }
      if (isWildcardDomain(cert.domain)) {
        if (given === undefined) throw new Error(`${at}: the Cert is for "${cert.domain}", so the CDN needs the hostname it serves: { domain: "files${cert.domain.slice(1)}" }`);
        if (!wildcardCovers(cert.domain, host)) throw new Error(`${at}: "${host}" is not covered by "${cert.domain}"; a wildcard covers exactly one label`);
      } else if (given !== undefined && host !== cert.domain) {
        throw new Error(`${at}: the CDN's domain "${host}" is not the Cert's "${cert.domain}"; use a wildcard Cert to serve other hostnames`);
      }
      return host;
    };
    const hostnames = new Map<string, string>();
    const claimHost = (host: string, at: string) => {
      const earlier = hostnames.get(host);
      if (earlier) throw new Error(`${at}: "${host}" is already served by the CDN at ${earlier}`);
      hostnames.set(host, at);
    };

    const cdns: CdnModel[] = [];
    const cdnCerts = new Set<CertificateModel>();
    for (const cdnExpr of siteCdnExprs) {
      const at = where(cdnExpr);
      const [providerArg, certArg, optionsArg] = cdnExpr.getArguments();
      if (stringLiteral(providerArg, `${at}: CDN provider`) !== "aws") throw new Error(`${at}: CDN provider must be "aws"`);
      const cdnCert = certOf(certArg, "the CDN's cert", at);
      if (cdnCerts.has(cdnCert) && !isWildcardDomain(cdnCert.domain)) throw new Error(`${at}: two CDNs cannot share a Cert unless it is a wildcard (*.example.com); give each its own domain`);
      cdnCerts.add(cdnCert);
      const host = servedHost(cdnCert, optionsArg, at);
      claimHost(host, at);
      subdomain(host, cdnCert, at, "the site");
      if (!optionsArg || !Node.isObjectLiteralExpression(optionsArg)) throw new Error(`${at}: CDN options must be an object literal with a bucket`);

      let bucketStore: Store | undefined;
      for (const prop of optionsArg.getProperties()) {
        if (Node.isSpreadAssignment(prop)) throw new Error(`${at}: spread in CDN options cannot be analyzed`);
        if (propName(prop) === "bucket") {
          const decl = valueDeclaration(prop);
          bucketStore = decl && resourceByDecl.get(decl);
        }
      }
      if (!bucketStore) throw new Error(`${at}: the CDN's bucket must be a BlobStore variable declared in your project`);
      if (bucketStore.resource.provider !== "aws") throw new Error(`${at}: the CDN's bucket must use provider "aws"`);
      if (bucketStore.resource.name.includes(".")) {
        warnings.push(`${at}: bucket "${bucketStore.resource.name}" contains dots; CloudFront's HTTPS connection to its S3 endpoint may fail certificate checks`);
      }
      if (bucketStore.resource.dry) {
        warnings.push(`${at}: bucket "${bucketStore.resource.name}" is dry, but the CDN adds one statement to its bucket policy`);
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
      if (cdnCert.region && cdnCert.region !== "us-east-1") {
        throw new Error(`${at}: a CDN needs its certificate in us-east-1, but the Cert says ${cdnCert.region}`);
      }
      cdnCert.usage = "cdn";
      cdns.push({
        provider: "aws",
        domain: host,
        certificate: cdnCert.domain,
        options: readOptionsMap(optionsArg, "options", `${at}: CDN`),
        bucket: bucketStore.resource.name,
        path: bucketStore.path,
      });
    }

    let api: EdgeModel["api"];
    const [routerCdnExpr] = routerCdnExprs;
    if (routerCert !== undefined && routerCdnExpr) {
      throw new Error(`${where(router)}: serve the router through API Gateway (a cert) or through a CDN, not both`);
    }
    const directCalls = (at: string, how: string, advice: string, domainOf: string) => {
      if (hasOption(routerOptions, "authenticate") && !jwtSettings) {
        const open = [...publicRoutes].find(([, isPublic]) => !isPublic);
        if (open) {
          throw new Error(
            `${at}: with ${how}, functions are called directly and the router's authenticate hook does not run for "${open[0]}"; mark it { public: true }, use jwtAuth, or ${advice}`,
          );
        }
      }
      if (hasOption(routerOptions, "rateLimit")) {
        warnings.push(`${at}: rateLimit does not apply to routes served on ${domainOf}`);
      }
    };
    if (routerCert !== undefined) {
      const at = where(router);
      const cert = certOf(routerCert, "the router's cert", at);
      if (cdnCerts.has(cert)) throw new Error(`${at}: the router and the CDN cannot share a Cert; give each its own domain`);
      if (isWildcardDomain(cert.domain)) {
        throw new Error(`${at}: a wildcard Cert cannot serve the router through API Gateway; use a Cert for the exact domain, or serve the router through a CDN`);
      }
      subdomain(cert.domain, cert, at, "the API");
      claimHost(cert.domain, at);
      if (provider !== "aws") {
        throw new Error(`${at}: serving the router on a Cert's domain uses API Gateway, which needs provider "aws", but the router uses "${provider}"`);
      }
      if (cert.region && cert.region !== routerRegion) {
        throw new Error(`${at}: the router's Cert must be in the function region (${routerRegion ?? "the deploy region"}), but it says ${cert.region}`);
      }
      directCalls(at, "a cert on the router", "drop the cert", "the cert's domain");
      cert.usage = "api";
      api = { provider: "aws", domain: cert.domain };
    }
    if (routerCdnExpr) {
      const at = where(routerCdnExpr);
      const [providerArg, certArg, optionsArg] = routerCdnExpr.getArguments();
      if (stringLiteral(providerArg, `${at}: CDN provider`) !== "aws") throw new Error(`${at}: CDN provider must be "aws"`);
      const cert = certOf(certArg, "the CDN's cert", at);
      if (cdnCerts.has(cert) && !isWildcardDomain(cert.domain)) throw new Error(`${at}: two CDNs cannot share a Cert unless it is a wildcard (*.example.com); give each its own domain`);
      cdnCerts.add(cert);
      const routerHost = servedHost(cert, optionsArg, at);
      claimHost(routerHost, at);
      subdomain(routerHost, cert, at, "the API");
      if (cert.region && cert.region !== "us-east-1") throw new Error(`${at}: a CDN needs its certificate in us-east-1, but the Cert says ${cert.region}`);
      if (!optionsArg || !Node.isObjectLiteralExpression(optionsArg)) throw new Error(`${at}: CDN options must be an object literal with a router`);
      let routerOk = false;
      for (const prop of optionsArg.getProperties()) {
        if (Node.isSpreadAssignment(prop)) throw new Error(`${at}: spread in CDN options cannot be analyzed`);
        const key = propName(prop);
        if (key === "bucket") throw new Error(`${at}: a CDN serves either a bucket or a router, not both`);
        if (key === "router") {
          const decl = valueDeclaration(prop);
          routerOk = !!decl && Node.isVariableDeclaration(decl) && chainRoot(decl.getInitializer()) === router;
        }
      }
      if (!routerOk) throw new Error(`${at}: the CDN's router must be the app's FunctionRouter, passed as a variable`);
      const methodRouting = readStringOption(optionsArg, "methodRouting", `${at}: CDN options`);
      if (methodRouting !== undefined && methodRouting !== "function") throw new Error(`${at}: methodRouting must be "function"`);
      if (authenticated !== "iam") {
        throw new Error(`${where(router)}: a CDN reaches functions through CloudFront origin access control, which needs authenticated: "iam"`);
      }
      if (jwtSettings?.header === "authorization") {
        throw new Error(
          `${where(router)}: with a CDN, jwtAuth needs a header other than "authorization" (for example { header: "x-auth-token" }); CloudFront origin access control signs requests to functions with that header`,
        );
      }
      directCalls(where(router), "a CDN", "drop the CDN", "the CDN's domain");

      const routes = [...functions.values()].flatMap((fn) => fn.routes.map((r) => ({ method: r.method, path: r.path, function: fn.name })));
      const conflicts = conflictingGroups(routes);
      if (conflicts.length && methodRouting !== "function") {
        const lines = conflicts.map((group) => `  ${group.pattern} is served by ${group.functions.map((name) => `"${name}"`).join(" and ")} (${group.methods.join(", ")})`);
        throw new Error(
          [
            `${at}: CloudFront routes by path only, but these paths reach different functions:`,
            ...lines,
            "Choose one:",
            "  - serve the router through API Gateway: pass { cert } to the router instead of a CDN (about $1 per million requests, no extra charge for method routing);",
            "  - give each of those paths one function that handles every method;",
            '  - set methodRouting: "function" on the CDN: a CloudFront Function picks the function by method and path on every request (about $0.10 per million invocations after 2 million free a month, plus a little latency; check current CloudFront pricing).',
          ].join("\n"),
        );
      }
      if (methodRouting === "function" && !conflicts.length) {
        warnings.push(`${at}: methodRouting is set but no path reaches several functions; no CloudFront Function will be created`);
      }
      const behaviors = methodRouting === "function" && conflicts.length ? 0 : behaviorsFor(routes).length;
      const origins = new Set(routes.map((r) => r.function)).size;
      if (behaviors > 25 || origins > 25) {
        warnings.push(`${at}: ${behaviors} behaviors and ${origins} origins; a CloudFront distribution allows 25 of each by default, so request a quota increase`);
      }
      const bodied = new Set(routes.map((r) => r.method).filter((m) => m === "POST" || m === "PUT"));
      if (bodied.size) {
        warnings.push(`${at}: ${[...bodied].sort().join(" and ")} requests through the CDN MUST carry an x-amz-content-sha256 header holding the SHA-256 hex digest of the body (origin access control for Lambda requires it)`);
      }
      cert.usage = "cdn";
      api = {
        provider: "aws",
        domain: routerHost,
        ...(routerHost !== cert.domain ? { certificate: cert.domain } : {}),
        via: "cloudfront",
        ...(methodRouting === "function" && conflicts.length ? { method_routing: true } : {}),
        options: readOptionsMap(optionsArg, "options", `${at}: CDN`),
      };
    }
    return { certificates: [...certificates.values()], cdns, api };
  }

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

  function addSchedules(fn: AnalyzedFunction, schedules: ScheduleModel[]) {
    for (const schedule of schedules) if (!fn.schedules.some((s) => JSON.stringify(s) === JSON.stringify(schedule))) fn.schedules.push(schedule);
  }

  function isCronTag(node: Node): boolean {
    if (!Node.isTaggedTemplateExpression(node)) return false;
    const tag = node.getTag();
    const decl = Node.isIdentifier(tag) ? resolveSymbol(tag.getSymbol())?.getDeclarations()[0] : undefined;
    return !!decl && Node.isFunctionDeclaration(decl) && decl.getName() === "cron" && packages.nameOf(decl.getSourceFile().getFilePath()) === "@cloudgear/functions";
  }

  function readCron(node: Node | undefined, at: string): string {
    if (!node || !isCronTag(node) || !Node.isTaggedTemplateExpression(node)) {
      throw new Error(`${at}: a schedule must be cron\`...\` from @cloudgear/functions, got: ${node?.getText() ?? "nothing"}`);
    }
    const template = node.getTemplate();
    if (!Node.isNoSubstitutionTemplateLiteral(template)) throw new Error(`${at}: cron\`...\` cannot contain \${} substitutions`);
    try {
      toEventBridgeCron(template.getLiteralValue());
      return normalizeCron(template.getLiteralValue());
    } catch (err) {
      throw new Error(`${at}: ${(err as Error).message}`);
    }
  }

  function readSchedule(node: Node | undefined, at: string): ScheduleModel {
    if (!node || !Node.isObjectLiteralExpression(node)) return { cron: readCron(node, at) };
    let cronNode: Node | undefined;
    let query: Record<string, string> | undefined;
    for (const prop of node.getProperties()) {
      if (Node.isSpreadAssignment(prop)) throw new Error(`${at}: spread in a schedule cannot be analyzed`);
      const key = propName(prop);
      const value = Node.isPropertyAssignment(prop) ? prop.getInitializer() : undefined;
      if (key === "cron") cronNode = value;
      else if (key === "query") {
        if (!value || !Node.isObjectLiteralExpression(value)) throw new Error(`${at}: a schedule's query must be an object literal of strings`);
        const pairs = new Map<string, string>();
        for (const entry of value.getProperties()) {
          const name = Node.isPropertyAssignment(entry) ? propName(entry) : undefined;
          if (!name || !Node.isPropertyAssignment(entry)) throw new Error(`${at}: a schedule's query entries must be name: "value"`);
          const text = stringLiteral(entry.getInitializer(), `${at}: query ${name}`);
          if (!QUERY_NAME.test(name) || !QUERY_VALUE.test(text) || name === "__proto__") throw new Error(`${at}: query ${name}=${text} may only use letters, digits and _ . : / -`);
          if (pairs.has(name)) throw new Error(`${at}: query ${name} is given twice`);
          pairs.set(name, text);
        }
        query = Object.fromEntries([...pairs].sort(([a], [b]) => a.localeCompare(b)));
      } else throw new Error(`${at}: a schedule takes cron and query, not "${key}"`);
    }
    return { cron: readCron(cronNode, at), ...(query && Object.keys(query).length ? { query } : {}) };
  }

  function readSchedules(node: Node | undefined, at: string): ScheduleModel[] {
    const nodes = node && Node.isArrayLiteralExpression(node) ? node.getElements() : [node];
    return nodes.map((item) => readSchedule(item, at));
  }

  function readScheduleOption(options: Node | undefined, at: string): ScheduleModel[] {
    if (!options || !Node.isObjectLiteralExpression(options)) return [];
    const prop = options.getProperties().find((p) => !Node.isSpreadAssignment(p) && propName(p) === "schedule");
    if (!prop) return [];
    return readSchedules(Node.isPropertyAssignment(prop) ? prop.getInitializer() : undefined, at);
  }

  function isScheduleDecorator(decorator: Node): boolean {
    if (!Node.isDecorator(decorator)) return false;
    const callee = decorator.getCallExpression()?.getExpression();
    const decl = callee && Node.isIdentifier(callee) ? resolveSymbol(callee.getSymbol())?.getDeclarations()[0] : undefined;
    return !!decl && Node.isFunctionDeclaration(decl) && decl.getName() === "schedule" && packages.nameOf(decl.getSourceFile().getFilePath()) === "@cloudgear/functions";
  }

  function findScheduledMethods(): { node: Node; label: string; schedules: ScheduleModel[] }[] {
    const found: { node: Node; label: string; schedules: ScheduleModel[] }[] = [];
    for (const file of localFiles) {
      for (const method of file.getDescendantsOfKind(SyntaxKind.MethodDeclaration)) {
        const decorators = method.getDecorators().filter(isScheduleDecorator);
        if (!decorators.length) continue;
        const at = where(method);
        if (!Node.isClassDeclaration(method.getParent())) throw new Error(`${at}: @schedule applies to a method of a class declaration`);
        const schedules = decorators.flatMap((decorator) => readSchedules(decorator.getCallExpression()?.getArguments()[0], `${where(decorator)}: @schedule`));
        found.push({ node: method, label: method.getName(), schedules });
      }
    }
    return found;
  }

  function isPolicyDecorator(decorator: Node): boolean {
    if (!Node.isDecorator(decorator)) return false;
    const callee = decorator.getCallExpression()?.getExpression();
    const decl = callee && Node.isIdentifier(callee) ? resolveSymbol(callee.getSymbol())?.getDeclarations()[0] : undefined;
    return !!decl && Node.isFunctionDeclaration(decl) && decl.getName() === "policy" && packages.nameOf(decl.getSourceFile().getFilePath()) === "@cloudgear/blob";
  }

  function exportedInstances(cls: ClassDeclaration): VariableDeclaration[] {
    return localFiles
      .flatMap((file) => file.getVariableDeclarations())
      .filter((variable) => {
        const init = variable.getInitializer();
        const created = init && Node.isNewExpression(init) ? resolveSymbol(init.getExpression().getSymbol())?.getDeclarations()[0] : undefined;
        return created === cls && exportNameOf(variable) !== undefined;
      });
  }

  function instanceExport(cls: ClassDeclaration, receiver?: Node): { exportName: string; file: string } | undefined {
    const receiverDecl = receiver && Node.isIdentifier(receiver) ? resolveSymbol(receiver.getSymbol())?.getDeclarations()[0] : undefined;
    const chosen = exportedInstances(cls).filter((variable) => !receiver || variable === receiverDecl);
    const only = chosen.length === 1 ? chosen[0]! : undefined;
    return only && { exportName: exportNameOf(only)!, file: relative(only.getSourceFile().getFilePath()) };
  }

  function instanceProblem(decl: Node, receiver?: Node): string | undefined {
    const cls = Node.isMethodDeclaration(decl) && !decl.isStatic() ? decl.getParent() : undefined;
    if (!cls || !Node.isClassDeclaration(cls)) return undefined;
    const names = exportedInstances(cls).map((variable) => exportNameOf(variable));
    if (!names.length) return `no exported instance of ${cls.getName() ?? "the class"}; add \`export const x = new ${cls.getName() ?? "Class"}(...)\``;
    if (!receiver && names.length > 1) return `${names.length} exported instances of ${cls.getName()} (${names.join(", ")}); route the method through one of them`;
    return `the receiver must be an exported instance variable itself (one of ${names.join(", ")}), not an alias or property`;
  }

  function functionFor(decl: Node, fnNode: NonNullable<ReturnType<typeof functionNode>>, label: string, receiver?: Node, scriptName?: string, hasInput = true): AnalyzedFunction {
    const existing = functions.get(decl);
    if (existing) {
      const again = receiver ? exportTargetOf(decl, instanceExport, receiver) : undefined;
      if (again && again.exportName !== existing.exportName) {
        throw new Error(`${where(decl)}: "${label}" is routed through two different instances (${existing.exportName}, ${again.exportName}); a method belongs to one instance`);
      }
      return existing;
    }
    const target = exportTargetOf(decl, instanceExport, receiver);
    if (!target) {
      const problem = instanceProblem(decl, receiver);
      throw new Error(
        `${where(decl)}: "${label}" must be exported so it can be bundled on its own (a named function, a method of an exported object, a static method of an exported class, or a method of an exported instance of a class)${problem ? `: ${problem}` : ""}`,
      );
    }
    const param = hasInput ? fnNode.getParameters()[0] : undefined;
    const fn: AnalyzedFunction = {
      name: target.member
        ? `${target.exportName}-${target.member}`
        : target.exportName === "default"
          ? (scriptName ?? path.parse(decl.getSourceFile().getFilePath()).name)
          : target.exportName,
      declaredName: declaredNameOf(decl),
      file: target.file ?? relative(decl.getSourceFile().getFilePath()),
      exportName: target.exportName,
      member: target.member,
      inputType: param?.getTypeNode()?.getText(),
      routes: [],
      schedules: [],
      secrets: [],
      events: [],
      policies: [],
      publishes: [],
      envUse: { variables: {}, dynamic: [] },
      include: [],
      passRequest: false,
      uses: new Map(),
    };
    const tallies = new Map<string, Tally>();
    secretUses = [];
    publishUses = new Set();
    collectUsage(fnNode, tallies, new Set());
    fn.secrets = uniqueSecrets(secretUses);
    fn.publishes = [...publishUses].sort();
    secretUses = undefined;
    publishUses = undefined;
    const policies = readPolicies(fnNode, fn.name);
    for (const [key, allowed] of policies) {
      const tally = tallies.get(key);
      const extra = [...(tally ? [...tally.ops, ...tally.grants] : [])].filter((access) => !allowed.has(access));
      if (tally?.widenedAt && tally.grants.size === 0) {
        throw new Error(
          `${where(tally.widenedAt)}: BlobStore "${tally.store.resource.name}" is passed around as a value, so the @policy of "${fn.name}" cannot guard it; call it directly or declare grant(store, ...)`,
        );
      }
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
    functionNodes.set(fn, fnNode);
    return fn;
  }

  function readPolicies(fnNode: Node, fnName: string): Map<string, Set<BlobAccess>> {
    const result = new Map<string, Set<BlobAccess>>();
    if (!Node.isMethodDeclaration(fnNode)) return result;
    for (const decorator of fnNode.getDecorators()) {
      const call = decorator.getCallExpression();
      if (!call || !isPolicyDecorator(decorator)) continue;
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
    // Property access names the store; judge the whole expression.
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

// Computed keys cannot be analyzed.
function propName(prop: Node): string | undefined {
  if (!Node.isPropertyAssignment(prop) && !Node.isShorthandPropertyAssignment(prop) && !Node.isMethodDeclaration(prop)) return undefined;
  const key = prop.getNameNode();
  if (Node.isIdentifier(key)) return key.getText();
  if (Node.isStringLiteral(key) || Node.isNoSubstitutionTemplateLiteral(key)) return key.getLiteralValue();
  if (Node.isNumericLiteral(key)) return key.getLiteralText();
  throw new Error(`${relative(prop.getSourceFile().getFilePath())}:${prop.getStartLineNumber()}: computed property keys cannot be analyzed`);
}

function sameOptions(a: Record<string, string> | undefined, b: Record<string, string> | undefined): boolean {
  return JSON.stringify(Object.entries(a ?? {}).sort()) === JSON.stringify(Object.entries(b ?? {}).sort());
}

function readOptionsMap(options: Node | undefined, name: string, at: string): Record<string, string> | undefined {
  if (!options || !Node.isObjectLiteralExpression(options)) return undefined;
  const prop = options.getProperties().find((p) => !Node.isSpreadAssignment(p) && propName(p) === name);
  if (!prop) return undefined;
  const map = Node.isPropertyAssignment(prop) ? prop.getInitializer() : undefined;
  if (!map || !Node.isObjectLiteralExpression(map)) throw new Error(`${at}: ${name} must be an object literal`);
  const result: Record<string, string> = {};
  for (const entry of map.getProperties()) {
    if (Node.isSpreadAssignment(entry)) throw new Error(`${at}: spread in ${name} cannot be analyzed`);
    const key = propName(entry);
    const value = Node.isPropertyAssignment(entry) ? entry.getInitializer() : undefined;
    if (!key || !value) throw new Error(`${at}: ${name} entries must be key: literal`);
    if (!/^[A-Za-z][A-Za-z0-9_.]*$/.test(key)) throw new Error(`${at}: ${name} key "${key}" must start with a letter and use letters, digits, "_" and "."`);
    if (Node.isStringLiteral(value) || Node.isNoSubstitutionTemplateLiteral(value)) result[key] = value.getLiteralValue();
    else if (Node.isNumericLiteral(value)) result[key] = value.getLiteralText();
    else if (value.getKind() === SyntaxKind.TrueKeyword || value.getKind() === SyntaxKind.FalseKeyword) result[key] = value.getText();
    else throw new Error(`${at}: ${name}.${key} must be a string, number or boolean literal, got: ${value.getText()}`);
  }
  return Object.keys(result).length ? result : undefined;
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

interface RouteSettings {
  name?: string;
  public: boolean;
  include: { rel: string; abs: string }[];
  request: boolean;
  response?: "helper" | "writer";
}

function readRouteOptions(options: Node | undefined, at: string, callerFile: string, responseKindOf: (prop: Node) => "helper" | "writer" | undefined): RouteSettings {
  const result: RouteSettings = { public: false, include: [], request: false };
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
    } else if (key === "request") {
      const value = Node.isPropertyAssignment(prop) ? prop.getInitializer()?.getText() : undefined;
      if (value !== "true" && value !== "false") throw new Error(`${at}: route request must be the literal true or false`);
      result.request = value === "true";
    } else if (key === "response") {
      result.response = responseKindOf(prop);
      if (!result.response) throw new Error(`${at}: route response must be \`response\` or \`VercelResponse\`, imported from @cloudgear/functions`);
    } else if (key === "include") {
      const value = Node.isPropertyAssignment(prop) ? prop.getInitializer() : undefined;
      const items = value && Node.isArrayLiteralExpression(value) ? value.getElements() : value ? [value] : [];
      if (!items.length) throw new Error(`${at}: route include must be a string literal or an array of them`);
      const byRel = new Map<string, { rel: string; abs: string }>();
      for (const item of items) {
        for (const file of expandInclude(stringLiteral(item, `${at}: route include`), callerFile, at)) byRel.set(file.rel, file);
      }
      result.include = [...byRel.values()].sort((a, b) => (a.rel < b.rel ? -1 : 1));
    }
  }
  return result;
}

const REGION = /^[a-z]{2,5}(-[a-z]+)+-\d$/;

function readRegion(options: Node | undefined, at: string): string | undefined {
  const region = readStringOption(options, "region", `${at} options`);
  if (region !== undefined && !REGION.test(region)) throw new Error(`${at}: "${region}" is not an AWS region such as "eu-west-1"`);
  return region;
}

function readOptionalEnv(options: Node | undefined, at: string): string[] {
  if (!options || !Node.isObjectLiteralExpression(options)) return [];
  const prop = options.getProperties().find((p) => !Node.isSpreadAssignment(p) && propName(p) === "optionalEnv");
  if (!prop) return [];
  let value = Node.isPropertyAssignment(prop) ? prop.getInitializer() : undefined;
  while (value && (Node.isAsExpression(value) || Node.isSatisfiesExpression(value) || Node.isParenthesizedExpression(value))) value = value.getExpression();
  if (!value || !Node.isArrayLiteralExpression(value)) throw new Error(`${at}: optionalEnv must be an array of string literals`);
  return value.getElements().map((item) => {
    const name = stringLiteral(item, `${at}: optionalEnv`);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`${at}: optionalEnv "${name}" is not an environment variable name`);
    return name;
  });
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

function valueDeclaration(prop: Node): Node | undefined {
  if (Node.isShorthandPropertyAssignment(prop)) return resolveSymbol(prop.getValueSymbol())?.getDeclarations()[0];
  if (Node.isPropertyAssignment(prop)) {
    const init = prop.getInitializer();
    return init && Node.isIdentifier(init) ? resolveSymbol(init.getSymbol())?.getDeclarations()[0] : undefined;
  }
  return undefined;
}

function readCertReference(options: Node | undefined, at: string): Node | undefined {
  if (!options || !Node.isObjectLiteralExpression(options)) return undefined;
  for (const prop of options.getProperties()) {
    if (Node.isSpreadAssignment(prop) || propName(prop) !== "cert") continue;
    const decl = valueDeclaration(prop);
    if (!decl) throw new Error(`${at}: the router's cert must be a variable`);
    return Node.isVariableDeclaration(decl) ? decl.getNameNode() : decl;
  }
  return undefined;
}

function chainRoot(node: Node | undefined): Node | undefined {
  let current = node;
  while (current && Node.isCallExpression(current)) {
    const callee = current.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) return undefined;
    current = callee.getExpression();
  }
  return current;
}

const ROUTER_MEMBERS = new Set(["listen", "fetch", "provider", "mode"]);

// Throws when the router flows somewhere untraceable.
function collectAddCalls(router: NewExpression, where: (node: Node) => string, isCdnOption: (node: Node) => boolean): CallExpression[] {
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
    // Usages in other files are followed separately.
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
    if (parent && isCdnOption(parent)) return;
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

function declaredNameOf(decl: Node): string {
  if (Node.isFunctionDeclaration(decl)) return decl.getName() ?? "";
  if (Node.isVariableDeclaration(decl)) {
    const init = decl.getInitializer();
    // Named function expressions keep their own name at runtime.
    return Node.isFunctionExpression(init) && init.getName() ? init.getName()! : decl.getName();
  }
  if (Node.isMethodDeclaration(decl) || Node.isPropertyAssignment(decl)) return propName(decl) ?? "";
  return "";
}

interface ExportTarget {
  exportName: string;
  member?: string;
  file?: string;
}

type InstanceExport = (cls: ClassDeclaration, receiver?: Node) => { exportName: string; file: string } | undefined;

function exportTargetOf(decl: Node, instanceExport: InstanceExport, receiver?: Node): ExportTarget | undefined {
  const direct = exportNameOf(decl);
  if (direct) return { exportName: direct };
  if (!Node.isMethodDeclaration(decl) && !Node.isPropertyAssignment(decl)) return undefined;
  const object = decl.getParent();
  if (Node.isMethodDeclaration(decl) && Node.isClassDeclaration(object)) {
    const member = decl.getName();
    if (!/^[A-Za-z_$][\w$]*$/.test(member)) return undefined;
    if (decl.isStatic()) {
      const exportName = exportNameOf(object);
      return exportName ? { exportName, member } : undefined;
    }
    const instance = instanceExport(object, receiver);
    return instance ? { ...instance, member } : undefined;
  }
  const variable = Node.isObjectLiteralExpression(object) ? object.getParentIfKind(SyntaxKind.VariableDeclaration) : undefined;
  const exportName = variable && variable.getInitializer() === object ? exportNameOf(variable) : undefined;
  const member = decl.getName();
  if (!exportName || !/^[A-Za-z_$][\w$]*$/.test(member)) return undefined;
  return { exportName, member };
}

function projectRootOf(file: string): string {
  const pkg = findUp(path.dirname(file), "package.json");
  return pkg ? path.dirname(pkg) : path.dirname(file);
}

function resolveRoutePath(spec: string, callerFile: string): string {
  if (spec.startsWith("./") || spec.startsWith("../")) return path.resolve(path.dirname(callerFile), spec);
  return path.join(projectRootOf(callerFile), spec.replace(/^\/+/, ""));
}

function scriptOf(call: CallExpression): string | undefined {
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== "url") return undefined;
  const [method, , script] = call.getArguments();
  if (!(method && Node.isStringLiteral(method) && (METHODS as readonly string[]).includes(method.getLiteralText().toUpperCase()))) return undefined;
  if (!script || !(Node.isStringLiteral(script) || Node.isNoSubstitutionTemplateLiteral(script))) return undefined;
  return resolveRoutePath(script.getLiteralText(), call.getSourceFile().getFilePath());
}

// Named after its root path: "api/v/[slug].ts" is "api-v-slug".
function scriptNameOf(scriptFile: string, callerFile: string): string {
  const rel = path.relative(projectRootOf(callerFile), scriptFile).replace(/\.[^./\\]+$/, "");
  return rel.replace(/[^A-Za-z0-9_]+/g, "-").replace(/^-+|-+$/g, "") || "script";
}

const outside = (rel: string) => rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);

function expandInclude(spec: string, callerFile: string, at: string): { rel: string; abs: string }[] {
  const root = projectRootOf(callerFile);
  const abs = resolveRoutePath(spec, callerFile);
  const rel = path.relative(root, abs);
  if (rel === "") throw new Error(`${at}: include "${spec}" must name a file or directory below the project root`);
  if (outside(rel)) throw new Error(`${at}: include "${spec}" is outside the project`);
  if (rel === ".cloudgear" || rel.startsWith(`.cloudgear${path.sep}`)) throw new Error(`${at}: include "${spec}" is generated output`);
  if (!fs.existsSync(abs)) throw new Error(`${at}: include "${spec}" not found (paths start at ${relative(root)})`);
  if (outside(path.relative(fs.realpathSync(root), fs.realpathSync(abs)))) throw new Error(`${at}: include "${spec}" resolves outside the project`);
  const files = (entry: string): string[] => {
    const stat = fs.lstatSync(entry);
    if (stat.isSymbolicLink()) throw new Error(`${at}: include "${spec}" contains a symbolic link (${relative(entry)}); include the real files`);
    return stat.isDirectory() ? fs.readdirSync(entry).flatMap((name) => files(path.join(entry, name))) : [entry];
  };
  const found = files(abs).map((file) => ({ rel: path.relative(root, file).split(path.sep).join("/"), abs: file }));
  if (found.some((f) => f.rel === "index.mjs")) throw new Error(`${at}: include "${spec}" would replace the function's index.mjs`);
  return found;
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

function checkPathParams(routePath: string, fnNode: ReturnType<typeof functionNode> & {}, at: string, leadingParams = 0) {
  const params = [...routePath.matchAll(/\{([A-Za-z_$][\w$]*)\}/g)].map((m) => m[1]!);
  const param = fnNode.getParameters()[leadingParams];
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

