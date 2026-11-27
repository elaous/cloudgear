# A Go cloudgear CLI

Status: proposal. Nothing in this document is built. It records what the owner decided, turns the decision
into an architecture and a port plan, states what the port has to match, and lists what is still open and
blocks the first step. It selects, for deployment, the design that polymorph's `docs/foreign-handlers.md`
calls B (the CLI reads polymorph's evaluated model), as a Go library and not as JSON, and so supersedes that
document's choice among A, B and C.

## What the owner decided

- The setup is written once, in a `.polymorph` file. `polymorph gen` writes `setup.ts`, `setup.go` or
  `setup.py`. A TypeScript project uses the TypeScript client library, a Go project the Go one, a Python
  project the Python one, and the generated setup MUST import that language's **client library** (the blob
  and secrets clients and the like that handler code calls). It does not import deploy drivers: those exist
  only in the CLI.
- The CLI is a Go program that uses polymorph and applies changes as the TypeScript CLI does today. The
  reason is distribution: a Go binary is better than a tree of `node_modules`.
- The CLI lives in the cloudgear repository as a new Go module, if open question 1 allows it. The TypeScript
  CLI MUST stay until the Go CLI reaches parity and MUST NOT be removed before.
- The state format stays compatible (below). The CLI reads the `.polymorph` file directly, and
  `cloudgear.prototxt` is dropped, which removes the only place attached origins are stored (see "What the Go
  CLI replaces").
- The user MUST build the handler artifacts before `apply` (a Go binary zip, a Python zip, a TypeScript
  bundle); the CLI hashes, checks and uploads them. It needs no Go, Python or Bun toolchain to deploy.
- Permissions come from an analyzer written in Go. Its scope is open question 2.

## Architecture

```
.polymorph ──> polymorph (eval, check) ──> setup.ts / setup.go / setup.py  (imports the language's client library)
      │
      └──> cloudgear (Go): model ─> plan ─> apply ─> state    ◄── handler artifacts built by the user
                          ▲
                          └─ analyzer: permissions from handler calls, and `access` lists
```

- **Model.** A Go port of what `generate.ts` derives from the analyzer: physical names and clash checks,
  option serialization and validation (`providers.ts`), certificate `usage`, the API domain, the variables
  that name a resource (`CLOUDGEAR_BLOB_<NAME>` and the others), secret bindings, schedules, event triggers.
  It reads polymorph's evaluated result through the Go packages, not the JSON of `polymorph eval`, because the
  JSON has no source positions, leaves `$env` templates unresolved and is not schema-checked. The CLI resolves
  `env` values and `param`s itself, from the shell, an env file and `-p`.
- **Plan and apply.** A port of `plan.ts`, `apply.ts`, `adopt.ts`, `protect.ts`, the state store, `site-files`,
  `site-plan`, `site-sync`, `policyfiles`, `dnscheck`, `cdnselect`, `permissions.ts`, and the commands and flags of
  `cli.ts` (including `--env`, `--tag`, `--author`, `--skip-dns-check`, `--allow-empty-remote`, `--ignore-unsaved`
  and the `CLOUDGEAR_*_DRIVER` switches that select fake drivers in tests).
- **Drivers.** AWS: S3 and sites, Lambda, IAM, ACM, CloudFront (and CloudFront Functions), API Gateway,
  EventBridge schedules and buses, ECR, Kinesis, ElastiCache, EC2 and instances, network resolution, SSM and
  Secrets Manager, Route 53. GCP: GCS, Cloud Functions, Cloud CDN, Certificate Manager and the IAM grants, over
  REST. Neon and Gandi over REST. The shared package logic that `plan.ts` and the drivers import (wildcard
  coverage, the cron conversion, blob path and CORS validators, the cache tables) is part of the port, about
  4,200 lines of `packages/*`.
- **Secrets at apply time.** `readSecretRef` (DNS tokens) and the environment check before `apply` are needed
  by the first step that applies a certificate, not only by the `secrets` command.
- **Client libraries.** `polymorph/runtime` and `python/` hold the blob and secrets clients; events and cache
  clients are missing. The TypeScript generator already imports `@cloudgear/*`, so for TypeScript the decision
  changes nothing; for Go and Python it reverses `docs/go-runtime.md`'s rule that generated setup packages MUST
  NOT import the library (see open question 3).

## What the Go CLI replaces, and what the schema has to gain first

The TypeScript analyzer and the committed `cloudgear.prototxt` do more than the schema can express today. The
Go CLI MUST NOT plan against a state it cannot reproduce, so these are decisions before step 2, each either a
schema addition (a proto change, a `buf breaking` check, a rebuilt `cloudgear.binpb`) or an explicit
"not migratable":

- Kinds the schema lacks: `Instance`, `Database`, `Registry`, `Stream`. A project that uses them would plan
  deletes or protection refusals on its first Go plan.
- The `cloudgear: dry` comment directive (a resource that is never created, updated or deleted).
- JWT authentication (`Authentication` is only `iam` or `none` in the schema).
- A CDN `path`, the router-CDN options, attached origins (carried across runs by `previousAttached` and written
  by `import`), and the `--invoker` and `--reserved-concurrency` inputs (command-line flags today).
- Function naming. A state key is `@aws.Lambda.<name>`, with the name taken from the TypeScript export, member
  or script path (relative to the nearest `package.json`). A route in a Go or Python project has none of those:
  the schema needs a name rule that reproduces existing names, or an existing function plans a replace.
- Project name: `parseState` refuses a state of another project. The TypeScript CLI takes it from `--project` or
  `package.json`; the `.polymorph` file has `project "x"`. The doc's rule: the file wins, and `--project` MUST
  agree with it or the run stops.
- The `cloudgear:version` tag comes from `package.json`; the Go binary's version changes it, so the tag value
  is part of the compatibility decision.
- What is lost without the analyzer: source file and line (`source` on resources), handler files and exports,
  path-parameter checks against handler signatures, the grouping of routes into functions, the environment
  scan behind `local.env`, `envreport` and the missing-variable error, the loop warning for event handlers,
  `optionalEnv` checks. Each MUST be re-created, moved into the schema, or dropped on purpose.
- The committed config file. README says the prototxt is normally committed and that the same variables are
  used for each environment; without it resolution happens on every run, and the resolved plan is the review
  artifact (`plan` output, not a file).

## Compatibility is the hard part

Compatibility means: a state last applied by the TypeScript CLI, from equivalent inputs, MUST plan as no change
in the Go CLI, and a Go `apply` MUST leave a state the TypeScript CLI reads for as long as both exist. The
exceptions are listed above and stated per step. The contract includes:

- **Specs.** `StateEntry.spec` holds the planner's objects (`FunctionComparable`, the CDN and certificate specs,
  site settings), compared by canonical JSON, which sorts object keys and not arrays. The Go planner MUST build
  specs as maps (a Go `omitempty` would drop meaningful zeros such as `region: ""` and `reserved_concurrency: 0`),
  omit exactly the keys the TypeScript spreads omit, and reproduce array order, which uses JavaScript's
  `localeCompare` (ICU collation) for `policies`, `secrets`, route keys and method routes, and the default UTF-16
  order for `actions` and `invokers`. Go's byte order differs for mixed case and for `{`, `/` and `_`; the port
  MUST use the same collation (for example `golang.org/x/text/collate`) and a test that proves it.
- **Text inside values.** Option values such as `options.cors`, `site_cache_control`, `site_include`,
  `site_exclude` and policy documents are JSON text built with `JSON.stringify` in a fixed key order. They are
  compared as bytes, so Go MUST NOT use `json.Marshal` defaults (it escapes `<`, `>` and `&` and orders struct
  fields by declaration); it needs a writer with the same output.
- **The config-shaped side of an entry.** `DesiredEntry.source` is not stored, but the drivers read it. The Go
  planner needs a config-shaped model, not only specs, and drivers also read other entries' state
  (`spec.policies`, `outputs.role_name`).
- **Markers and outputs.** The `incomplete` marker and its `previous` spec (`incompleteSpec`, read again by
  `permissions.ts`), `physical_name`, `imported`, `deps` and `refresh`, and the `outputs` keys that other code
  consumes (`url`, `domain_name`, `id`, `api_id`, `status`, `role_name`, `project`, `url_map`, `address`,
  `vpc_id` and the rest), which `endpointsFrom`, `invalidate`, `import` and `@output:` references read.
- **The store.** `.cloudgear/state.json`, the S3 state with its `state.lock` (`id`, `holder`, `command`,
  `since`, `pid`) and conditional writes, `endpoints.json` (which the TypeScript `router.fetch` reads at
  `.cloudgear/endpoints.json`: a cross-language contract), the `state.remote.json` marker and the
  `state.json.unsaved.*` recovery files.
- **Bundles and hashes.** For a script bundle `code` is the SHA-256 of `index.mjs` plus each included file, the
  handler is `index.handler` and `NODE_OPTIONS` is set. For a finished zip (`archive: true`, cloudgear PR 107)
  `code` is the SHA-256 of the file, the handler is the configured one and `NODE_OPTIONS` is absent. So a
  TypeScript function moved to archive mode plans one `code` update, one `config` update and an environment
  change, and the Go CLI MUST keep the script-bundle mode for TypeScript functions: `code`, the handler and the
  environment as above, wrapped in a zip by the CLI. Archive mode MUST be limited to Lambda functions with a
  non-TypeScript runtime (the GCP driver builds its own `index.mjs` and has no zip path, and Lambda takes a zip
  in the request, 50 MB at most).

The TypeScript bundle's hash is the hash of what `Bun.build` writes: the wrapper, the user's code, the
functions library, the Bun version and the minification all matter. A different recipe changes `code`; the cost
is one `UpdateFunctionCode` per function, no replacement, and it already happens today across machines and Bun
versions. A user-built zip SHOULD be deterministic (fixed timestamps), or its `code` changes on every build.

### The oracle

The conformance suite has two layers, written before the code it checks:

1. **Config to desired entries.** Hook `plan()` / `desiredEntries` in the TypeScript tests (`tests/helpers.ts`
   builds `CloudgearConfig` objects directly) and record each `(config, state)` pair and its entries as
   fixtures; the Go planner, given the same config-shaped input, MUST produce the same entries after key
   sorting, array order preserved.
2. **`.polymorph` to config.** Only two fixtures come from polymorph today (`tests/fixtures/polymorph`). Each
   other scenario needs a hand-written `.polymorph` twin, and fixtures that test analyzer features the schema
   lacks are out of the oracle and listed as such.

The AWS fakes (`fakeAws`) are one `send(command)` stub keyed by command name with SDK v3 inputs; the Go SDK v2
has a client per service. The doubles are rewritten per operation, and the TypeScript tests' calls are recorded
as transcripts (operation and input) for the Go tests to replay. The rest of the contract also needs oracles:
the text of `plan`, `--permissions` and the warnings and errors that tests assert, the state store's lock and
conditional-write behavior, driver call order and retries, and the README rules for behavior the tests miss.

## The settings a TypeScript function bakes in

`bundleFunction` writes an `entry.ts` that compiles into the function the route table, `trustContext` (aws, `iam`,
no API domain), the JWT settings and `anonymous` flag, the `request` and `response` modes, the secret bindings
and the loader, and the included files. A plain `bun build` carries none of it, and neither does a Go or
Python binary. How these settings reach a function of each language, through environment variables or a config
field the runtime reads, is a decision that MUST be made before the functions step, together with the functions
runtime libraries (about 1,600 lines of `packages/functions` to port to Go and to Python), which MUST land
before or with the function deploy that depends on them. Until a runtime that verifies tokens exists, a
function that is not TypeScript MUST be refused on a router with `jwtAuth` or `authenticated: none`: it has a
public Function URL, and `createHandler` is the only place tokens are verified. A TypeScript project still
needs Bun to build its bundle and to run `setup.ts`.

## Port plan

Each step is a pull request with an independent review, the TypeScript CLI keeps working, and each step names
the oracle that proves parity.

0. **Inventory and schema.** The compatibility items above written down as a checklist with the oracle for each,
   the schema additions or "not migratable" decisions (instance, database, registry, stream, `dry`, JWT, CDN
   path, attached origins, naming), and the settings mechanism. No code.
1. **Module and harness.** The Go module, the state types and stores (file and S3 with the lock), the fixture
   export hook on the TypeScript side, the comparison test. No user value yet.
2. **Model and plan for resources, certificates, CDNs and API domains**, with `readSecretRef`, `check-dns`,
   `state`, `plan` and `plan --permissions` (which needs only plan specs).
3. **Drivers and `apply`, `destroy`, `import`**, one pull request per family, each against recorded transcripts:
   S3 and sites; certificates, DNS and CloudFront; API Gateway and schedules; the rest of AWS; GCP; Neon.
4. **Functions:** the model's function derivation, script-bundle and finished-zip upload, the settings
   mechanism and the Go and Python runtime libraries, secrets, schedules, event triggers.
5. **The analyzer** and the environment report, per open question 2.
6. **Generators import the client libraries** and the remaining commands (`secrets`, `invalidate`,
   `dump-distributions`).
7. **Removal of the TypeScript CLI,** after every oracle matches and the owner has moved a live deployment.

Size, from the TypeScript line counts at a ratio of about 1.3 to 1.5: steps 1 and 2 about 6,000 to 8,000 lines of
Go, step 3 about 9,000 to 11,000 (four to six pull requests), step 4 about 5,000 including the runtimes, step 5
about 1,200 to 1,800 for Go and 1,500 to 2,500 for each syntax-level analyzer, step 6 about 1,500; in all about
22,000 to 28,000 lines of production Go and 12,000 to 15,000 of tests, against about 11,600 lines of TypeScript
to port (the analyzer and the TypeScript runtime stay in TypeScript).

## Open questions

The owner MUST decide 1, 2 and 3 before step 1 and the others before the step that needs them.

1. **polymorph is private and cloudgear is public.** A Go module in cloudgear that imports polymorph cannot be
   built by outside contributors, by fork pull requests (no secrets) or by `go install`; the public CI builds
   it only with `GOPRIVATE` and a token. The generated Go and Python setups would also import a private client
   library, which makes every user project depend on a private repository. The options: make polymorph public;
   split a public module (`syntax`, `eval`, `schema`) from the private generator code; move the CLI and the
   libraries into the polymorph repository; publish the client libraries in their own public repository
   (`docs/go-runtime.md` already recommends it). A pinned vendored copy MUST NOT be committed to the public
   repository, and a `replace` or `go.work` needs a sibling checkout. The decision that the CLI lives in this
   repository depends on this answer.
2. **What the Go analyzer reads.** For Go handlers, `go/types` through `golang.org/x/tools/go/packages` resolves
   calls on a store handle, but it needs the module and its dependencies on the machine that runs it, so it
   runs in the user's build (a vet tool that writes JSON the CLI reads), not inside a CLI that needs no
   toolchain. For TypeScript and Python there is no type checker in Go: a syntax-level pass (tree-sitter needs
   cgo; `gpython` parses Python 3.4) finds direct calls on declared stores, not aliases, re-exports, stores
   passed on or `client()`. The TypeScript analyzer today also follows calls through local functions, methods
   and constructors across files, treats a store passed as a value or `client()` as widened (all operations,
   with a warning, unless `grant` or `@policy` narrows it) and checks `@policy` over-grants. The owner's answer
   was that a Go analyzer exists in the design; the scope per language MUST be stated. The recommendation is one
   mechanism per language: declared `access` for TypeScript and Python (the analyzer, if any, only checks it),
   the Go vet tool for Go, and `access` extended beyond blob stores (events, cache) before any project migrates,
   because `Access` references `BlobStore` only today. A migration helper SHOULD derive `access` from a state's
   permissions.
3. **Generated setups that import the library.** The library MUST NOT import generated code. Writing library
   constructors in `gen go` and `gen py` changes nine golden files, the test that compiles generated Go (which
   then needs the runtime module resolved), `Location()` and `blob.Open` (redundant or changed), and pulls the
   cloud SDKs into every consumer unless drivers stay in subpackages. `docs/go-runtime.md` and
   `docs/foreign-handlers.md` MUST be updated in the same change.
4. **Names and versions.** The module path, the package names and the Go version (the polymorph module is on
   `go 1.24`), settled before step 1 because they decide question 1.
5. **A TypeScript project's build step.** The settings mechanism above decides whether a plain `bun build`
   recipe is enough or cloudgear ships a bundling helper.
