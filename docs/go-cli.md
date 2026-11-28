# A Go cloudgear CLI, with a library per language

Status: proposal. Nothing in this document is built. It records what the owner decided, turns it into an
architecture and a port plan, states what the port MUST match, and lists what is still open. It replaces two
earlier versions. The first had the CLI read a `.polymorph` file; the owner rejected that, because a second
schema language defeats the purpose of writing infrastructure in real code. Polymorph's language, schema,
evaluator, generators and access checks are therefore legacy, and `docs/foreign-handlers.md` and
`docs/go-runtime.md` in the polymorph repository MUST be marked superseded when this is adopted.

## What the owner decided

- The setup is written in the project's own language, as real code: `setup.ts`, `setup.py` or `setup.go`.
  There is no neutral language and no schema a user writes. `cloudgear.prototxt` stays what it is today: a
  reviewable, committed configuration that `generate` writes and `plan` and `apply` read.
- The CLI and the drivers are a Go program named `cloudgear`: `plan`, `apply`, `import`, `destroy`, `state`,
  `check-dns`, `invalidate`, `dump-distributions`, `secrets` and the drivers for every provider. It ships as one
  binary and needs no Node, Bun, Python or Go toolchain to plan and apply.
- `generate` is per language. The TypeScript one is the existing analyzer; Python and Go get their own,
  written in their own language and run with the toolchain the user already has. The Go binary does not parse
  TypeScript or Python; `cloudgear generate` MAY find `setup.ts`, `setup.py` or `setup.go` and run the matching
  tool, and the user can run that tool directly.
- The runtime library of each language is ported and served in that language's ecosystem: npm for TypeScript,
  the Go module proxy for Go, PyPI for Python. Each library holds both halves, as the TypeScript packages do:
  the declarations a setup uses (`new BlobStore("aws", ...)`) and the clients that handler code calls.
- The state format stays compatible: a state last applied by the TypeScript CLI, from equivalent inputs, MUST
  plan as no change in the Go CLI, and a Go `apply` MUST leave a state the TypeScript CLI reads for as long as
  both exist. The TypeScript CLI MUST stay until the Go CLI reaches parity and MUST NOT be removed before.

## Architecture

```
setup.ts ──(static analysis, ts-morph: existing)──┐
setup.py ──(dump by running, Python library)──────┼─> generate ─> cloudgear.prototxt ─┐
setup.go ──(dump by running, Go library)──────────┘   (+ site hashes, bundle hashes)  │
handler artifacts: TypeScript bundled by `generate`; Go and Python built by the user ──┤
                                                                                      v
                         cloudgear (Go): plan ─> apply ─> state, endpoints.json ─> drivers (AWS, GCP, Neon, DNS)
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

- Step 0 MUST specify one canonical encoding of the prototxt, with golden files, and every generator MUST emit
  it byte for byte; Go's `prototext.Marshal` is documented as unstable and MUST NOT be used to write it.
- The Go reader MUST port `decodeConfig`'s validation, not only the parsing.
- `cloudgear.proto` is outside the buf module (`proto/` only); step 0 MUST bring it under `buf lint` and
  `buf breaking` so the contract has an owner.
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

### Go and Python generators

- **TypeScript** keeps static analysis: it never runs the user's code, reads literals and call graphs with the
  type checker, and infers permissions from the calls handlers make. It does not change.
- **Go and Python SHOULD dump by running.** `cloudgear generate` runs the setup in a dump mode; the
  constructors record their declarations and an explicit call writes the result (Go has no exit hook, so
  `cloudgear.Dump(setup)` from a `main`; Python MAY use `atexit` or the same explicit call). Parsing Go and
  Python constructor calls statically is fragile (aliases, loops, helpers) and execution is exact.
- **The dump SHOULD emit a neutral model, and one Go implementation SHOULD derive the prototxt from it.**
  The prototxt is not a transcript of constructor calls: `generate.ts`, `providers.ts`, `names.ts` and the model
  half of the analyzer derive physical names and clash checks, variable names, option serialization, provider
  defaults, certificate usage, the API domain and CDN options. If each library derived them there would be three
  implementations. A model (JSON, internal, never written by a user) that the Go binary's `generate` turns into
  the prototxt leaves two (TypeScript and Go), and the TypeScript analyzer MAY emit the same model later to leave
  one. This costs the derivation port that the version of this plan without it avoided, about 4,000 to 5,000
  lines.
- **Permissions** in Go and Python come from explicit declarations (`grant(store, "read")` style, as `grant()`
  and `@policy` in TypeScript), checked by the Go binary against the plan; a vet pass for Go that derives them
  from calls is later work. A cross-language oracle MUST use explicit grants in its TypeScript fixture too.
- **Handlers and hashes.** A route names the built artifact, runtime, handler and architecture (the
  finished-zip fields of PR 107). The finished-zip hash is today written by hand (`generate` does not write
  archive functions). The contract MUST be: the user builds the artifact, then `generate` records its path and
  SHA-256, then `plan` and `apply` check it (the order is build, generate, plan, apply, and every code change
  rewrites the committed prototxt, as a TypeScript bundle does). CDK and Pulumi hash assets themselves at synth or
  `up`; computing it at apply time would change what `Bundle.sha256` means and is not proposed.
- **`dry`** cannot come from a comment in Go or Python: it is an explicit option (`Resource.dry` exists).
- **`env` values.** A TypeScript setup reads `process.env` at generate time from the shell and `--env-file`
  (the shell wins; an empty value is unset; an unset variable fails with its name and line), and the resolved
  value is written to the committed prototxt, which MUST NOT hold credentials. The Go and Python generators MUST
  keep these rules: `cloudgear generate` loads `--env-file` into the child's environment with the same
  precedence and the library reports the missing variable by name.
- **Running user code is a risk:** the setup runs with the developer's credentials and network, and `init()` and
  import-time work execute. The setup MUST live in a package that imports only the library (a Go `main` of its
  own, a Python module that imports no handler), the library's clients MUST refuse network and credentials when
  the dump variable is set, and CI SHOULD check that regenerating gives no diff. CDK also runs the app at synth
  and caches context lookups to keep it deterministic; Pulumi runs it on every preview and has an unknown-value
  model that this design lacks, so every option MUST be concrete at dump time. `plan` stays hermetic because
  `generate` is a separate step, which is an advantage over both.
- **Divergence.** A TypeScript setup is limited to what the static analyzer reads; Go and Python accept strictly
  more programs. The dump SHOULD enforce a reviewable subset (concrete values, no I/O) so the prototxt oracle
  has the same inputs in all three languages, and the document does not promise that a program valid in Go is
  valid in TypeScript.

### The settings a function bakes in

`bundleFunction` writes an `entry.ts` that compiles the route table, `trustContext`, the JWT settings,
`request` and `response` modes and the secret bindings into a TypeScript function. A Go or Python function
has no such wrapper, so how these reach it (environment variables or a config field the runtime reads) MUST be
decided before any non-TypeScript function is deployed, and the Go and Python functions runtimes (about 2,000
lines each, ported from `packages/functions` and `packages/core`) MUST land before or with it. Until a runtime
that verifies tokens exists, a function that is not TypeScript MUST be refused on a router with `jwtAuth` or
`authenticated: none`, because it has a public Function URL. Go and Python functions on GCP are unsupported
until a source-deploy path exists (the GCP driver builds its own `index.mjs`). A TypeScript function keeps the
script-bundle mode (hash of `index.mjs` and includes, handler `index.handler`, `NODE_OPTIONS` set);
finished-zip mode is for non-TypeScript Lambda functions (a zip goes up in the request, 50 MB at most). Local
mode (`FunctionRouter.listen` and `fetch`) needs the in-process function in Go and Python, so one declaration
has to serve both.

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

1. **Config to entries.** Hook `plan()` and `desiredEntries` in the TypeScript tests (`tests/helpers.ts` builds
   `CloudgearConfig` objects directly), record each `(config, state)` pair and its entries, and require the Go
   planner, given the same prototxt, to produce the same entries after key sorting, array order preserved.
2. **Cross-language generation.** The same infrastructure written as `setup.ts`, `setup.py` and `setup.go` MUST
   produce the same prototxt after a defined normalization. The normalization list MUST name every
   language-specific field (`source` as `file:line`, `Function.source`, `bundle.path`, function names, which a
   TypeScript setup takes from the export or member name and Go and Python state explicitly) and the oracle
   MUST NOT silently ignore anything else.
3. **The rest of the contract,** each with a named check: the text of `plan` and `--permissions` and the
   warnings and errors that tests assert, the state store's lock and conditional-write behavior, driver call
   order and retries, site-file hashing, the state file's bytes, the CloudFront Function text. The AWS test
   doubles (`fakeAws`, one `send(command)` stub with SDK v3 inputs) are rewritten for the Go SDK's per-service
   clients, and the TypeScript tests' calls are recorded as transcripts for the Go tests to replay.

## Port plan

Each step MUST be a pull request with an independent review, the TypeScript CLI MUST keep working, and each
step MUST name the oracle that proves parity. Steps 1 to 3 give TypeScript users a Go `plan` and `apply` and are
shippable alone; nothing ships to Go or Python users before step 6.

0. **Inventory and contract.** The compatibility items above as a checklist with the oracle for each, the
   canonical prototxt encoding with golden files, `cloudgear.proto` under buf, where each shared piece of code
   lives, and the decisions on the neutral model, the settings mechanism and the build-then-generate order. No
   code beyond the contract files.
1. **Module and harness.** The Go module in this repository, the state types and stores (file and S3 with the
   lock), the fixture export hook on the TypeScript side, the comparison test. No user value yet.
2. **Plan:** the prototxt reader with `decodeConfig`'s validation, the planner for resources, certificates, CDNs
   and API domains, `readSecretRef`, `check-dns`, `state`, `plan` and `plan --permissions`.
3. **Drivers and `apply`, `destroy`, `import`,** one pull request per family, each against recorded transcripts:
   S3 and sites; certificates, DNS and CloudFront; API Gateway and schedules; the rest of AWS; GCP; Neon. This
   includes bundle reading and the hash check, `--env-file`, `secrets`, the confirmation prompt with the lock and
   the interrupt handling, `invalidate`, `dump-distributions` and the flags listed above.
4. **TypeScript functions:** the function plan, the script-bundle upload, secrets, schedules and event triggers.
   A standalone entry point for the TypeScript generator (`generate` is a case inside `src/cli.ts` today).
5. **Libraries, runtimes and generators:** the declaration half of the Go and Python libraries with constants
   generated from the protos, the dump mode and the neutral model with the Go derivation, the Go and Python
   functions runtimes and the settings mechanism, then non-TypeScript function deploy (finished-zip), then
   events, cache and the remaining libraries, with the cross-language oracle.
6. **Serving the libraries:** npm (build to `.js` and `.d.ts`, rewrite `workspace:*`, an organization for the
   `@cloudgear` scope, provenance), a Go module with its own `go.mod` and path-prefixed version tags (the
   module proxy needs this repository public), a PyPI package renamed from `polymorph-runtime`, release workflows,
   and public CI for Go and Python (`setup-go`, `setup-python`, dependabot `gomod` and `pip`, CodeQL languages,
   a per-language mapping in `scripts/changed-tests.ts`, CONTRIBUTING). Publishing needs the owner's registry
   accounts and decision and MUST NOT be done without them. The CLI resolves `@cloudgear/secrets` with
   `Bun.resolveSync` when bundling; that MUST keep working from a user project.
7. **Removal of the TypeScript CLI,** keeping the TypeScript generator and library, after every oracle matches
   and the owner has moved a live deployment; the generator then needs Bun or Node, and `bun build --compile`
   MAY package it as one binary. `tests/polymorph.test.ts` and `tests/fixtures/polymorph/` are retired with
   polymorph.

Size, from the TypeScript line counts at a ratio of about 1.3 to 1.5: the CLI and drivers (about 8,600 lines)
plus the shared package code (about 1,500) give steps 1 to 4 about 13,000 to 17,000 lines of Go. Step 5 is about
14,000: the declaration and client halves of the packages other than `functions` (about 3,700 Go, 3,000 Python),
the functions runtimes (about 2,000 each), and a dump and derivation layer (about 1,500 per library, plus about
4,000 to 5,000 once in the Go binary if the neutral model is chosen). In all about 27,000 to 31,000 lines of
production Go and Python and 12,000 to 15,000 of tests, against about 11,600 lines of TypeScript to port. The
earlier version of this plan claimed about 5,000 lines fewer; once the derivation is counted, it does not.

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

The owner MUST decide 1 and 2 before step 0 ends, 3 before step 5, 4 before step 6 and 5 before step 1.

1. **Dump by running or static analysis for Go and Python, and the neutral model.** The recommendation is dump
   by running with explicit grants, emitting a neutral model that one Go implementation derives into the
   prototxt. Static analysis per language needs a type checker in that language (Go can use `go/types` through
   `golang.org/x/tools/go/packages` in the user's build; Python has no equivalent) and finds only direct calls on
   declared stores. Three implementations of the derivation is the alternative and costs about 4,000 to 5,000
   lines more in the libraries.
2. **The settings mechanism** for non-TypeScript functions (environment variables or a config field), and
   whether a router that uses `jwtAuth` may hold non-TypeScript functions before a verifying runtime exists.
3. **Handler declaration in Go and Python:** the shape of a route that names an artifact, how one declaration
   serves local mode, and whether handler source is also located so `generate` can report environment variables
   as `local.env` does for TypeScript.
4. **Names and registries:** the npm scope (private today), the Go module path and layout under this repository,
   the PyPI name, and the registry accounts and credentials, which only the owner can create.
5. **The Go version** the binary requires and the module paths, and whether the TypeScript generator ships as a
   compiled binary once the TypeScript CLI is removed.
