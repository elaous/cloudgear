# A Go cloudgear CLI, with a library per language

Status: proposal. Nothing in this document is built. It records what the owner decided, turns it into an
architecture and a port plan, states what the port MUST match, and lists what is still open. It replaces
earlier versions. The first had the CLI read a `.polymorph` file; the owner rejected that, because a second
schema language defeats the purpose of writing infrastructure in real code. The second had Go and Python
setups dump their declarations by running them; this version replaces that with one static analyzer in Go,
after a measurement (below) showed that the TypeScript analyzer does not need a type checker. Polymorph's
language, schema, evaluator, generators and access checks are therefore legacy, and
`docs/foreign-handlers.md` and `docs/go-runtime.md` in the polymorph repository MUST be marked superseded when
this is adopted.

## What the owner decided

- The setup is written in the project's own language, as real code: `setup.ts`, `setup.py` or `setup.go`.
  There is no neutral language and no schema a user writes. `cloudgear.prototxt` stays what it is today: a
  reviewable, committed configuration that `generate` writes and `plan` and `apply` read.
- The CLI is a Go program named `cloudgear`: `generate`, `plan`, `apply`, `import`, `destroy`, `state`,
  `check-dns`, `invalidate`, `dump-distributions`, `secrets` and the drivers for every provider. It ships as one
  binary and needs no Node, Python or Go toolchain to analyze, plan and apply (TypeScript handlers still need
  Bun to be bundled; see "The settings a function bakes in").
- `generate` is one static analyzer in Go. It parses `setup.ts`, `setup.py` and `setup.go` with tree-sitter
  grammars that are translated to pure Go (`github.com/cgofree/tree-sitter` and its Python, TypeScript and Go
  grammars), resolves names itself, and writes the prototxt. The Go binary never runs the user's code.
- The proto of the configuration is under buf (`proto/cloudgear/config/v1/config.proto`, merged in cloudgear
  PR 110). The Go types are generated from it with `buf generate`; the analyzer builds that message and a
  canonical text emitter writes it.
- The runtime library of each language is ported and served in that language's ecosystem: npm for TypeScript,
  the Go module proxy for Go, PyPI for Python. Each library holds both halves, as the TypeScript packages do:
  the declarations a setup uses (`new BlobStore("aws", ...)`) and the clients that handler code calls.
- The state format stays compatible: a state last applied by the TypeScript CLI, from equivalent inputs, MUST
  plan as no change in the Go CLI, and a Go `apply` MUST leave a state the TypeScript CLI reads for as long as
  both exist. The TypeScript CLI MUST stay until the Go CLI reaches parity and MUST NOT be removed before.
- The user MUST build the handler artifacts for Go and Python before `apply` (a binary zip, a Python zip); the
  CLI hashes, checks and uploads them. A TypeScript handler is bundled as it is today (see below).

## Architecture

```
setup.ts ──┐ tree-sitter (pure Go) ─> syntax tree ─> language front end ─┐
setup.py ──┤  TypeScript, Python and Go grammars       (names, imports,   │
setup.go ──┘                                            constants, uses)  v
                          one Go derivation (names, options, usage, env) ─> config message (buf-generated types)
                                                                                      │ canonical text emitter
handler artifacts: TypeScript bundled with Bun; Go and Python built by the user       v
                                                              cloudgear.prototxt ─> cloudgear (Go): plan ─> apply ─> state,
                                                                                    endpoints.json ─> drivers (AWS, GCP, Neon, DNS)
```

### What the Go binary reads and writes

It is not true that the Go binary reads only the prototxt. `plan()` is a pure function of the config and the
state, but the commands also use:

- the **state** (`.cloudgear/state.json`, or S3 with its lock) and, for DNS tokens, `process.env`;
- the **site directories** named by `site_dir`: `plan` and `apply` read them again (`withSiteChanges`,
  `readSiteFiles`), recompute `site_files_hash` and refuse to go on when it differs from the config's
  ("changed since the config was generated; re-run generate"); the file selection (`Bun.Glob` include and
  exclude) and the content-type table MUST be reproduced;
- the **build artifacts**: `apply` reads each function's file at `bundle.path` (and the `files/` directory of
  included files), recomputes the hash and compares it with `bundle.sha256`. For TypeScript `generate` builds
  them with `Bun.build` into `.cloudgear/build/`; the user does not;
- `apply` writes `.cloudgear/endpoints.json` and stores it beside the state, even after a failure or when
  nothing changed; `import` rewrites `cloudgear.prototxt` (`syncAttached` inserts `attached { }` blocks by
  matching the generated layout), so the Go binary writes the prototxt too, and the layout is a contract;
- the author tag (`git config user.name`, `$USER`), `--env`, `--tag`, `--region` (router option, flag, then
  `AWS_REGION` and `GOOGLE_CLOUD_REGION`), `NEON_API_KEY`, and the `CLOUDGEAR_*_DRIVER` switches that select fake
  drivers in tests.

### The prototxt is a dialect

`src/config/prototxt.ts` is a hand-written encoder and parser: strings are quoted as JSON strings and field
order follows the keys of the object. `decodeConfig` also validates (bucket names, the archive, handler and
architecture rules, secret references, attached-origin JSON consistency). So:

- The config proto lives at `proto/cloudgear/config/v1/config.proto` (package `cloudgear.config.v1`) under
  `buf lint` and `buf breaking`, so the contract has an owner; the Go types are generated from it with
  `buf generate` and the analyzer builds that message.
- The Go binary MUST write the prototxt with a canonical emitter of its own that walks the generated message in
  the order the TypeScript writes it and quotes strings the way `JSON.stringify` does; protobuf-go's
  `prototext.Marshal` deliberately varies its whitespace between builds and MUST NOT be used to write it. Reading
  MAY use `prototext.Unmarshal`, which accepts the TypeScript output (72 generated configs and an all-fields
  config parsed without error in the review of PR 110). Step 1 MUST add golden files that both writers produce.
- The Go reader MUST port `decodeConfig`'s validation, not only the parsing.
- Every generator MUST carry over the `attached` blocks of the existing file (`previousAttached`), or the next
  `apply` removes the attached origins from live distributions.
- The side effects of `generate` are kept or dropped on purpose, each named in the port plan: the `local.env`
  update and `--no-local-env`, the deletion of `<config>.env.json`, the warning for git-tracked env files and
  the missing-variable check with `--allow-missing-env`.

### The libraries

Each library has, per resource kind, a constructor that records the declaration and a client that acts at run
time. The TypeScript packages are all `private: true` workspace packages at version 0.1.0 whose `exports` point
at raw `.ts`; no package imports `src/` and there are no cycles, so they can be published without untangling
the CLI. What they contain, and what the Go (`polymorph/runtime`) and Python (`python/`) libraries have:

| Library | TypeScript | Go | Python |
| --- | --- | --- | --- |
| blob | declaration, validators and constants, client | client only | client only |
| secrets | declaration, client, path validators | client only | client only |
| events | declaration and client | none | none |
| cache | declaration and a location accessor (`CLOUDGEAR_CACHE_*`); no client | none | none |
| functions | router declaration, `createHandler` runtime, `router.fetch` (SigV4, `endpoints.json` reader with `CLOUDGEAR_ENDPOINTS` and `CLOUDGEAR_ENDPOINTS_FILE` overrides), cron and method constants the planner imports | none | none |
| dns | declaration, client, Route 53 and Gandi drivers, `wildcardCovers` | none | none |
| cdn | `Cert` and `CDN` declarations, `status`, `url`, `fetch` (reads `endpoints.json`) | none | none |
| registry, stream, database, instance, network | declaration | none | none |
| iam | `Policy` declaration and validators; no client | none | none |
| core | handler runtime (`authenticated`, `claim`, `guard`) | none | none |
| debug | support code | none | none |

The declaration half is not only constructors. The analyzer and `providers.ts` import constants and validators
from it (`BLOB_STORE_OPERATIONS`, `BLOB_STORE_WEB_SITE_DEFAULTS`, `CACHE_ENGINES`, `DNS_PROVIDERS`,
`assertCorsRules`, `normalizeBlobPath`, `parseSecretPath` and more). These constants are generated from
`proto/cloudgear/v1/*.proto` by `scripts/gen-schema.ts`, so the Go and Python constants MUST be generated from
the same protos, not ported by hand; that gives the libraries a conformance source and puts `buf breaking` over
the shared values.

The port MUST give each library the same names and rules as the TypeScript (path and name validation,
`CLOUDGEAR_*` variables, memory drivers, error texts), and each MUST have a test that runs the TypeScript test
cases. What the existing Go and Python clients offer that is reusable is the drivers, validators and tests;
their entry point (`blob.Open(ctx, opener, handle)` with a generated `Location()`) changes with the declaration
half, and so do the module path and the Python package and import names.

The deploy-only code the CLI shares with the libraries today (`createDnsDriver` with the Gandi and Route 53
drivers, `wildcardCovers`, the cron conversion, the blob, CORS and site validators, the cache tables) MUST be
placed on purpose: runtime code in the library module, deploy-only code in the CLI module, and the CLI module
MAY import the library module for shared constants. Step 0 records which is which.

### The analyzer

The TypeScript analyzer reads literals and call graphs; it never runs the user's code, and that is a property
to keep ("reviewable, credential-free, deterministic"). The Go analyzer does the same for all three languages.

**It does not need a type checker.** The TypeScript analyzer (`src/analyze/app.ts`) makes no use of
`getTypeAtLocation`, call signatures, return types or assignability. It resolves names: `getSymbol()` 21 times,
`getDeclarations()` 25, `getAliasedSymbol()` once, `findReferencesAsNodes()` twice. It finds the uses of a store
by the references to the variable declared with `new BlobStore(...)` and classifies each reference by its
syntax (`store.get` is a read, passing the store as a value widens it). The only two real type calls are in
`checkPathParams`, which compares a handler's input type with the `{placeholders}` of its route path; that is
validation and the prototxt does not depend on it. A measurement on 28 November 2026:

| Measure | Result |
| --- | --- |
| Fixture and example files | 316; 291 import `@cloudgear/*`, 17 use relative imports, 3 use a `baseUrl` path, none re-exports, 2 alias an import, 2 use `import * as` |
| Top-level declarations compared, syntax-only resolver against the type-aware analyzer | 788 declarations, 784 references; 4 differences, all bare imports (`server/api`) that need the tsconfig `baseUrl`; 0 differences once it is read |
| Member accesses on classes declared in the fixtures (`Class.m`, `new C().m`, `this.m`, a parameter typed as a class) | 30; all resolved identically by syntactic rules; the other 450 or so go to cloudgear's own classes, which the analyzer handles by name |

The resolver was about 230 lines of TypeScript on ts-morph's parser, without the checker. The measurement has
limits: the corpus is mostly single-file test fixtures and one multi-file example, cross-file resolution was
exercised on about 20 import edges, there were no re-export chains, no tsconfig `paths` and no copy of a real
project, the parser was not tree-sitter's, and the analyzer's call-following logic was not re-implemented, only
the primitive it depends on (an identifier's declaration and a declaration's references). The first step of the
port MUST repeat the comparison with the Go resolver on tree-sitter trees; it is the oracle below.

**What the analyzer is.**

- **Front ends, one per language,** over tree-sitter trees: a binder (scopes, imports with module resolution:
  relative paths, the tsconfig `baseUrl` and `paths`, Python's package paths, Go import paths and the module
  path), constant folding (same-file and imported constants, string concatenation and templates,
  `process.env.X` or `os.environ` and `os.Getenv` resolved from the shell and `--env-file` with the TypeScript
  rules), initializer chasing, and recognition of the library's constructors by their import. A front end
  rejects what it cannot know, with a position, as the TypeScript analyzer does.
- **A shared model and one derivation in Go,** a port of what `generate.ts`, `providers.ts`, `names.ts` and
  `routes.ts` derive: physical names and clash checks, option serialization and validation, certificate usage,
  the API domain, the variables that name a resource, secret bindings, schedules, event triggers. There is one
  implementation for all three languages and TypeScript's is retired with the TypeScript CLI.
- **Permissions** are inferred from the references to each declared store, in all three languages, by the
  rules of the TypeScript analyzer (direct operations; `client()` and a store passed as a value widen it, with a
  warning, unless `grant(store, ...)` narrows it; `@policy` and `grant` equivalents for Python and Go). They are
  checked against the plan by the Go binary.
- **`checkPathParams`** is not ported at first: a path placeholder missing from the handler's input type is
  reported by the compiler's own checks only if the project writes them. A best-effort version (an inline object
  type, or a type alias in the same file) MAY come later.
- **`dry`** cannot come from a comment in Go or Python: it is an explicit option (`Resource.dry` exists), and
  the TypeScript directive keeps working.

**Tree-sitter's cost.** The `cgofree` modules are version 0.1.0, MIT licensed and translate the C runtime to Go;
they build with `CGO_ENABLED=0` (a spike produced a 5 MB binary that parsed equivalent setups in all three
languages in about 3 ms) and need Go 1.26. A dependency that young MUST be pinned, and its grammars (TypeScript
0.23.2, Python 0.25.0, Go 0.25.0) MUST be covered by the oracle. `microsoft/typescript-go` is not an option:
its parser and checker are `internal/` packages that Go refuses to import, its repository is closed in favor of
`microsoft/TypeScript`, and its README marks the API "not ready". `Pogo` is a transpiler for a Python subset and
is not a parser to depend on.

### The settings a function bakes in

`bundleFunction` writes an `entry.ts` that compiles the route table, `trustContext`, the JWT settings,
`request` and `response` modes and the secret bindings into a TypeScript function, and bundles it with
`Bun.build`. With a Go analyzer the Go binary knows all of that; what it cannot do without Bun is bundle. So for
TypeScript `cloudgear generate` MUST write the `entry.ts` and MAY run `bun build` as a subprocess, which makes
Bun a requirement for TypeScript projects only (they need Bun or Node to write handlers anyway); the bundle,
its hash and the `.cloudgear/build/` layout stay as they are, so the hash contract does not move. A Go or
Python function has no such wrapper, so how these settings reach it (environment variables or a config field the
runtime reads) MUST be decided before any non-TypeScript function is deployed, and the Go and Python functions
runtimes (about 2,000 lines each, ported from `packages/functions` and `packages/core`) MUST land before or with
it. Until a runtime that verifies tokens exists, a function that is not TypeScript MUST be refused on a router
with `jwtAuth` or `authenticated: none`, because it has a public Function URL. Go and Python functions on GCP
are unsupported until a source-deploy path exists (the GCP driver builds its own `index.mjs`). A TypeScript
function keeps the script-bundle mode (hash of `index.mjs` and includes, handler `index.handler`,
`NODE_OPTIONS` set); finished-zip mode is for non-TypeScript Lambda functions (a zip goes up in the request,
50 MB at most). Local mode (`FunctionRouter.listen` and `fetch`) needs the in-process function in Go and
Python, so one declaration has to serve both.

## Compatibility

The Go binary MUST reproduce or read:

- `StateEntry.spec` objects, compared by canonical JSON, which sorts object keys and not arrays. The Go planner
  MUST build specs as maps (a Go `omitempty` would drop meaningful zeros such as `region: ""`), omit exactly the
  keys the TypeScript spreads omit, and reproduce array order, which uses `localeCompare` for `policies`,
  `secrets`, route keys and method routes and UTF-16 order for `actions` and `invokers`. Go's byte order differs
  for mixed case and for `{`, `/`, `_`. `localeCompare` without a locale depends on the host, so the TypeScript
  MUST pass an explicit locale and the Go port MUST use the same collation (for example
  `golang.org/x/text/collate`) with a test that proves it.
- JSON text inside option values (`cors`, `site_cache_control`, `site_include`, `site_exclude`, policy
  documents) is compared as bytes; the prototxt carries it already built, so Go reads it as text and never
  re-serializes it.
- The config-shaped side of an entry (`DesiredEntry.source` is not stored but drivers read it), other entries'
  state (`spec.policies`, `outputs.role_name`), the `incomplete` marker and its `previous` spec,
  `PartialApplyError`, `physical_name`, `imported`, `deps`, `refresh`, the `@output:` references resolved
  at apply, and the `outputs` keys other code consumes (`url`, `domain_name`, `id`, `api_id`, `status`,
  `role_name`, `project`, `url_map`, `address`, `vpc_id` and more).
- The store: `.cloudgear/state.json` (written with two-space indent, a newline and an atomic rename), the S3
  state with its `state.lock` and conditional writes, the `state.remote.json` marker and the
  `state.json.unsaved.*` recovery files.
- `endpoints.json`: the Go binary MUST write it after `apply` (also after a failure or no change), store or
  remove its copy in S3 and handle `state pull`; the TypeScript router and `CDN.url` and `CDN.fetch` read it
  (`CLOUDGEAR_ENDPOINTS`, `CLOUDGEAR_ENDPOINTS_FILE`, a search upward from the working directory, a
  provider-mismatch error), and the Go and Python libraries MUST read it the same way.
- The ownership markers read back from the cloud, which MUST be preserved: the `cloudgear:managed-by` tag (EC2
  `createdByCloudgear`), the GCP labels `cloudgear_managed-by` and `cloudgear_resource`, the ECR lifecycle
  description prefix `cloudgear:`, and the CloudFront origin ids `cloudgear-site` and `cloudgear-fn-` (reserved
  by `OWN_ORIGIN`). The `cloudgear:version` tag comes from `package.json` and nothing reads it back, so its value
  is not a compatibility constraint.
- Generated text the drivers produce: the CloudFront Function route code (`route-function.ts`, with its
  `localeCompare` ordering), the site manifest in `outputs.site_manifest`, and the `.cloudgear/build/` layout
  (`index.mjs`, `files/`, `INCLUDED_DIR`).
- A TypeScript bundle's `code` hash is the hash of what `Bun.build` writes, so a different recipe changes it, at
  the cost of one `UpdateFunctionCode` per function and no replacement, as already happens across machines and
  Bun versions. A user-built zip SHOULD be deterministic (fixed timestamps).

### The oracle

1. **The analyzer against the TypeScript analyzer.** The 316 fixture and example files are the corpus: for each
   entry, the TypeScript CLI's `generate` output (prototxt, warnings and error texts) is recorded as a golden
   file, and the Go analyzer, given the same setup, MUST produce a byte-identical prototxt through the canonical
   emitter and the same errors with the same positions. Cases the TypeScript analyzer rejects for type reasons
   (`checkPathParams`) are listed as exceptions, and every exception is named. This is the strongest oracle in
   the plan and exists before any Go code does.
2. **Config to entries.** Hook `plan()` and `desiredEntries` in the TypeScript tests (`tests/helpers.ts` builds
   `CloudgearConfig` objects directly), record each `(config, state)` pair and its entries, and require the Go
   planner, given the same prototxt, to produce the same entries after key sorting, array order preserved.
3. **Cross-language generation.** The same infrastructure written as `setup.ts`, `setup.py` and `setup.go` MUST
   produce the same prototxt after a defined normalization. The normalization list MUST name every
   language-specific field (`source` as `file:line`, `Function.source`, `bundle.path`, function names, which a
   TypeScript setup takes from the export or member name and Go and Python state explicitly) and the oracle
   MUST NOT silently ignore anything else.
4. **The rest of the contract,** each with a named check: the text of `plan` and `--permissions` and the
   warnings and errors that tests assert, the state store's lock and conditional-write behavior, driver call
   order and retries, site-file hashing, the state file's bytes, the CloudFront Function text. The AWS test
   doubles (`fakeAws`, one `send(command)` stub with SDK v3 inputs) are rewritten for the Go SDK's per-service
   clients, and the TypeScript tests' calls are recorded as transcripts for the Go tests to replay.

## Port plan

Each step MUST be a pull request with an independent review, the TypeScript CLI MUST keep working, and each
step MUST name the oracle that proves parity. The analyzer comes first because it carries the risk and has the
best oracle; the planner and the drivers are independent of it, since both read the prototxt. Steps 1 to 4 give
TypeScript users a Go `generate`, `plan` and `apply` and are shippable alone; nothing ships to Go or Python
users before step 6.

0. **Inventory.** The compatibility items above as a checklist with the oracle for each, where each shared piece
   of code lives, and the decisions on the settings mechanism and the build-then-generate order. The config
   proto under buf is done (PR 110). No code.
1. **Module and harness.** The Go module in this repository, `buf generate` for the config types, the
   canonical emitter and the reader with `decodeConfig`'s validation and golden files, the state types and
   stores (file and S3 with the lock), and the recording of the TypeScript analyzer's outputs for the 316
   fixtures. No user value yet; oracles 1 and 2 are set up here.
2. **The analyzer for TypeScript.** The tree-sitter front end (binder, module resolution with `baseUrl` and
   `paths`, constant folding, initializer chasing, reference classification), the shared model, and the Go
   derivation (a port of `generate.ts`, `providers.ts`, `names.ts`, `routes.ts`), against oracle 1, with
   `local.env`, the environment report and the missing-variable check. The Go binary writes `cloudgear.prototxt`;
   TypeScript handlers are bundled by a Bun subprocess.
3. **Plan:** the planner for resources, certificates, CDNs, API domains and functions, `readSecretRef`,
   `check-dns`, `state`, `plan` and `plan --permissions`, against oracle 2.
4. **Drivers and `apply`, `destroy`, `import`,** one pull request per family, each against recorded transcripts:
   S3 and sites; certificates, DNS and CloudFront; API Gateway and schedules; the rest of AWS; GCP; Neon. This
   includes bundle reading and the hash check, `--env-file`, `secrets`, the confirmation prompt with the lock and
   the interrupt handling, `invalidate`, `dump-distributions` and the flags listed above.
5. **Python and Go:** the front ends over the same model, the declaration half of the Go and Python libraries
   with constants generated from the protos, the cross-language oracle (3), the Go and Python functions runtimes
   and the settings mechanism, then non-TypeScript function deploy (finished-zip), then events, cache and the
   remaining libraries.
6. **Serving the libraries:** npm (build to `.js` and `.d.ts`, rewrite `workspace:*`, an organization for the
   `@cloudgear` scope, provenance), a Go module with its own `go.mod` and path-prefixed version tags (the
   module proxy needs this repository public), a PyPI package renamed from `polymorph-runtime`, release workflows,
   and public CI for Go and Python (`setup-go`, `setup-python`, dependabot `gomod` and `pip`, CodeQL languages,
   a per-language mapping in `scripts/changed-tests.ts`, CONTRIBUTING). Publishing needs the owner's registry
   accounts and decision and MUST NOT be done without them. The CLI resolves `@cloudgear/secrets` with
   `Bun.resolveSync` when bundling; that MUST keep working from a user project.
7. **Removal of the TypeScript CLI and analyzer,** keeping the TypeScript library, after every oracle matches and
   the owner has moved a live deployment. `tests/polymorph.test.ts` and `tests/fixtures/polymorph/` are retired
   with polymorph.

Size, from the TypeScript line counts at a ratio of about 1.3 to 1.5, as estimates and not measurements: the
CLI, drivers and shared package code (about 10,000 lines) give about 13,000 to 15,000 lines of Go for steps 3
and 4; the analyzer's TypeScript front end and derivation (about 2,400 lines of `app.ts` and about 1,300 of
`generate.ts`, `providers.ts`, `names.ts` and `routes.ts`, less what only ts-morph needed) about 4,500 to 5,500
lines of Go, with a binder of about 400 (the prototype was 230 lines of TypeScript); the Python and Go front
ends about 1,000 to 1,500 each; the declaration and client halves of the libraries (about 3,700 Go, 3,000
Python) and the functions runtimes (about 2,000 each). In all about 30,000 to 36,000 lines of production Go and
Python and 12,000 to 15,000 of tests, against about 11,600 lines of TypeScript to port.

## What happens to polymorph

Its language, schema, evaluator, generators, access checks and CEL support are legacy: they MUST NOT receive new
features, and its README MUST say so. About 6,600 of its 7,952 non-test Go lines (`syntax`, `eval`, `schema`,
`gen/*`, `cmd`, `cel`), the `.polymorph` test data and the committed `cloudgear.binpb` are discarded. What is
reusable is its `runtime/blob` and `runtime/secrets` drivers, validators and tests (about 1,300 non-test lines
of Go, 770 of Python), the `CLOUDGEAR_BLOB_<NAME>` convention and the memory switches, and its test setups
(platform, shop, tranquilo) as a scenario inventory for the oracle. They MUST move into this public repository so
that users do not depend on a private one, and polymorph MUST NOT become a dependency. The schema additions of
cloudgear PR 106 (`Access`, named intents) are unused by the new design; removing them is a breaking change under
`buf breaking`, so it needs `reserved` fields or the owner's explicit decision.

## Open questions

The owner confirmed on 28 November 2026 ("Continue", after the measurement) that the Go analyzer covers
TypeScript as well as Python and Go. The rest MUST be decided before the step that needs it: 1 before step 5, 2
before step 6, 3 before step 2, 4 before step 1.

1. **The settings mechanism and the handler declaration for Go and Python.** How the route table,
   authentication settings and secret bindings reach a non-TypeScript function (environment variables or a
   config field), the shape of a route that names a built artifact (path, runtime, handler, architecture), how
   one declaration serves local mode, whether handler source is located so `generate` can report environment
   variables as `local.env` does for TypeScript, and whether a router that uses `jwtAuth` may hold
   non-TypeScript functions before a verifying runtime exists.
2. **Names and registries:** the npm scope (private today), the Go module path and layout under this repository
   (and that the proxy needs it public), the PyPI name, and the registry accounts and credentials, which only
   the owner can create.
3. **How TypeScript projects bundle:** a Bun subprocess of `cloudgear generate` (proposed), a compiled helper,
   or the user's own build step; and whether the loss of `checkPathParams` is acceptable.
4. **The Go version and the module path.** `cgofree` requires Go 1.26, so the CLI MUST be built with it; the
   polymorph module is on `go 1.24`.
5. **A third-party parser at 0.1.0.** Whether the owner accepts `cgofree/tree-sitter` pinned and covered by the
   oracle, or wants a fallback plan (vendoring the translated grammars into this repository, which MIT permits).
