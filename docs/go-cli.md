# A Go cloudgear CLI, with a library per language

Status: proposal. Nothing in this document is built. It records what the owner decided, turns it into an
architecture and a port plan, states what the port has to match, and lists what is still open. It replaces an
earlier version of this document, which had the CLI read a `.polymorph` file. The owner rejected that: a
second schema language defeats the purpose of writing infrastructure in real code. Polymorph's language,
schema, access checks and generators are therefore legacy, and `docs/foreign-handlers.md` and
`docs/go-runtime.md` in the polymorph repository MUST be marked superseded when this is adopted.

## What the owner decided

- The setup is written in the project's own language, as real code: `setup.ts`, `setup.py` or `setup.go`.
  There is no neutral language and no schema a user writes. `cloudgear.prototxt` stays what it is today, an
  internal, reviewable, committed configuration that `generate` writes and `plan` and `apply` read.
- The CLI and the drivers are a Go program named `cloudgear`: `plan`, `apply`, `import`, `destroy`, `state`,
  `check-dns`, `invalidate`, `secrets` and the drivers for every provider. It reads the prototxt and nothing
  else, so it needs no Node, Bun, Python or Go toolchain, and ships as one binary.
- `generate` is per language. The TypeScript one is the existing analyzer; Python and Go get their own, written
  in their own language and run with the toolchain the user already has. The Go binary does not parse
  TypeScript or Python: it can run the project's generator (`cloudgear generate` finds `setup.ts`, `setup.py` or
  `setup.go` and runs the matching tool), and the user can run that tool directly.
- The runtime library of each language is ported and served in that language's ecosystem: npm for TypeScript,
  the Go module proxy for Go, PyPI for Python. Each library holds both halves, as the TypeScript packages do:
  the declarations a setup uses (`new BlobStore("aws", ...)`) and the clients handler code calls (`store.get`).
  The generated setup of the earlier proposal is gone; the user writes the setup against the library.
- The user MUST build the handler artifacts before `apply` (a Go binary zip, a Python zip, a TypeScript
  bundle); the CLI hashes, checks and uploads them.
- The state format stays compatible: a state last applied by the TypeScript CLI, from equivalent inputs, MUST
  plan as no change in the Go CLI, and a Go `apply` MUST leave a state the TypeScript CLI reads for as long as
  both exist. The TypeScript CLI MUST stay until the Go CLI reaches parity and MUST NOT be removed before.

## Architecture

```
setup.ts ──(static analysis, ts-morph: existing)──┐
setup.py ──(dump by running, Python library)──────┼─> cloudgear.prototxt ──> cloudgear (Go): plan ─> apply ─> state
setup.go ──(dump by running, Go library)──────────┘                                  ▲ drivers (AWS, GCP, Neon, DNS)
handler code, built by the user into artifacts ─────────────────────────────────────┘ hashes and uploads them
```

The prototxt is the contract between the three generators and the Go binary. It already exists, it already
carries everything the planner needs, and every problem of a second model (specs, naming, environment
resolution, attached origins, kinds the schema lacks) stays with the TypeScript analyzer that already solves it.

### The libraries

Each library has, per resource kind, a constructor that records the declaration and a client that acts at run
time. Today the TypeScript packages are `blob`, `secrets`, `events`, `cache`, `functions` (the router and the
`createHandler` runtime), `dns`, `cdn`, `registry`, `stream`, `database`, `instance`, `network`, `iam`, `core`
and `debug`, all `private: true` workspace packages. Status of the others:

| Library | TypeScript | Go (`polymorph/runtime`) | Python (`python/`) |
| --- | --- | --- | --- |
| blob | declaration and client | client only | client only |
| secrets | declaration and client | client only | client only |
| events, cache | declaration and client | none | none |
| functions (router, `createHandler`) | declaration and runtime | none | none |
| dns, cdn, cert status | declaration and client | none | none |
| registry, stream, database, instance, network | declaration | none | none |

Porting means adding the declaration half to the Go and Python clients and then the missing libraries, each
with the same names and rules as the TypeScript (path and name validation, `CLOUDGEAR_*` variables, memory
drivers, error texts). A conformance test per library compares behavior against the TypeScript tests' cases.

### Go and Python generators

- **TypeScript** keeps static analysis: it never runs the user's code, reads literals and call graphs with the
  type checker, and infers permissions from the calls handlers make. It does not change.
- **Go and Python SHOULD dump by running.** `cloudgear generate` runs the setup in a dump mode (for example
  `CLOUDGEAR_DUMP=<file>` set, then `go run .` or `python setup.py`); the constructors record their
  declarations and the library writes the prototxt on exit. Parsing Go and Python constructor calls statically
  is fragile (aliases, loops, helpers) and execution is exact. The cost is that generate runs user code and
  needs the program to build. The alternative, a static analyzer per language, is open question 2.
- **Permissions** in Go and Python come from explicit declarations (`grant(store, "read")` style, as
  `grant()` and `@policy` in TypeScript), checked by the Go binary against the plan; a vet pass for Go that
  derives them from calls is later work, not a prerequisite.
- **Handlers.** A route names the built artifact, runtime, handler and architecture (the finished-zip fields of
  cloudgear PR 107), because the Go binary uploads artifacts and does not build them.

### What the Go binary needs from the settings a function bakes in

`bundleFunction` writes an `entry.ts` that compiles the route table, `trustContext`, the JWT settings,
`request` and `response` modes and the secret bindings into a TypeScript function. A Go or Python function has
no such wrapper, so how these reach it (environment variables or a config field the runtime reads) MUST be
decided before the functions step, with the functions runtime libraries for Go and Python (about 1,600 lines of
`packages/functions` each) landing before or with the function deploy that depends on them. Until a runtime that
verifies tokens exists, a function that is not TypeScript MUST be refused on a router with `jwtAuth` or
`authenticated: none`, because it has a public Function URL. A TypeScript function keeps the script-bundle mode
(hash of `index.mjs` and includes, handler `index.handler`, `NODE_OPTIONS` set); finished-zip mode is for
non-TypeScript Lambda functions (GCP functions have no zip path; Lambda takes a zip in the request, 50 MB at most).

## Compatibility

Specs, outputs, markers and files that the Go binary MUST reproduce or read:

- `StateEntry.spec` objects, compared by canonical JSON, which sorts object keys and not arrays. The Go planner
  MUST build specs as maps (a Go `omitempty` would drop meaningful zeros such as `region: ""`), omit exactly the
  keys the TypeScript spreads omit, and reproduce array order, which uses JavaScript's `localeCompare` for
  `policies`, `secrets` and route keys and UTF-16 order for `actions` and `invokers` (Go's byte order differs for
  mixed case and for `{`, `/`, `_`; the port MUST use the same collation and a test that proves it).
- JSON text inside option values (`cors`, `site_cache_control`, `site_include`, `site_exclude`, policy
  documents) is compared as bytes; the prototxt carries it already built, so Go reads it as text and never
  re-serializes it.
- The config-shaped side of an entry (`DesiredEntry.source` is not stored but drivers read it), other entries'
  state (`spec.policies`, `outputs.role_name`), the `incomplete` marker and its `previous` spec,
  `physical_name`, `imported`, `deps`, `refresh`, and the `outputs` keys other code consumes (`url`,
  `domain_name`, `id`, `api_id`, `status`, `role_name`, `project`, `url_map`, `address`, `vpc_id` and more).
- The store: `.cloudgear/state.json`, the S3 state with its `state.lock` and conditional writes,
  `endpoints.json` (which the TypeScript `router.fetch` reads: a cross-language contract the Go and Python
  libraries MUST read too), the `state.remote.json` marker and the `state.json.unsaved.*` recovery files.
- The `cloudgear:version` tag, which comes from `package.json` today; the Go binary's version changes it, so
  its value is a compatibility decision.
- A TypeScript bundle's `code` hash is the hash of what `Bun.build` writes; a different recipe changes it, at
  the cost of one `UpdateFunctionCode` per function and no replacement, as already happens across machines and
  Bun versions. A user-built zip SHOULD be deterministic (fixed timestamps).

### The oracle

1. **Config to entries.** Hook `plan()` / `desiredEntries` in the TypeScript tests (`tests/helpers.ts` builds
   `CloudgearConfig` objects directly) and record each `(config, state)` pair and its entries; the Go planner,
   given the same prototxt, MUST produce the same entries after key sorting, array order preserved.
2. **Cross-language generation.** The same infrastructure written as `setup.ts`, `setup.py` and `setup.go`
   MUST produce the same prototxt; this is the conformance suite for the new generators and libraries.
3. **The rest of the contract.** The text of `plan` and `--permissions` and the warnings and errors that tests
   assert, the state store's lock and conditional-write behavior, driver call order and retries. The AWS test
   doubles (`fakeAws`, one `send(command)` stub with SDK v3 inputs) are rewritten for the Go SDK's per-service
   clients, and the TypeScript tests' calls are recorded as transcripts for the Go tests to replay.

## Port plan

Each step is a pull request with an independent review, the TypeScript CLI keeps working, and each step names
the oracle that proves parity.

0. **Inventory.** The compatibility items above as a checklist with the oracle for each, the prototxt as the
   documented contract (a schema document for `cloudgear.proto`, which `buf` does not cover today), and the
   settings mechanism for non-TypeScript functions. No code.
1. **Module and harness.** The Go module in this repository, the state types and stores (file and S3 with the
   lock), the fixture export hook on the TypeScript side, the comparison test.
2. **Plan:** the prototxt reader, the planner for resources, certificates, CDNs and API domains, `readSecretRef`,
   `check-dns`, `state`, `plan` and `plan --permissions`.
3. **Drivers and `apply`, `destroy`, `import`,** one pull request per family, each against recorded transcripts:
   S3 and sites; certificates, DNS and CloudFront; API Gateway and schedules; the rest of AWS; GCP; Neon.
4. **Functions:** derivation of the function plan, script-bundle and finished-zip upload, the settings mechanism,
   secrets, schedules and event triggers.
5. **Libraries and generators:** the declaration half of the Go and Python libraries, the dump mode and the
   cross-language conformance suite, then events, cache and the remaining libraries and the Go and Python
   functions runtimes.
6. **Serving the libraries:** npm packages (today `private`), a Go module and a Python package, versioned
   together with the binary. Publishing needs the owner's registry accounts and decision; it is never done
   without them.
7. **Removal of the TypeScript CLI,** keeping the TypeScript generator and library, after every oracle matches
   and the owner has moved a live deployment. The generator then needs Bun or Node; `bun build --compile` MAY
   package it as one binary.

Size, from the TypeScript line counts at a ratio of about 1.3 to 1.5: steps 1 and 2 about 3,000 to 4,000 lines of
Go, step 3 about 9,000 to 11,000 (four to six pull requests), step 4 about 2,500, step 5 about 4,000 to 6,000
across the Go and Python libraries and runtimes, about 17,000 to 22,000 lines of production Go and Python in all
and about 10,000 to 13,000 of tests. This is about 5,000 lines fewer than the earlier design, which had to port
the model derivation of `generate.ts`.

## What happens to polymorph

Its language, schema, evaluator, generators and access checks become legacy and are frozen: no new features,
and the README says so. Its `runtime/` (Go) and `python/` libraries are the starting point of the libraries
above and MUST move into this repository, which is public, so that users do not depend on a private
repository. Its published decisions (`docs/go-runtime.md`, `docs/foreign-handlers.md`) are marked superseded. The
schema additions of cloudgear PR 106 (`Access`, named intents) are unused by the new design and MAY be removed.

## Open questions

The owner MUST decide 1 and 2 before step 5 and the others before the step that needs them.

1. **Libraries in the cloudgear repository, and the names to serve them under.** The npm scope (`@cloudgear` is
   a private workspace today), the Go module path (the module and package layout under this repository) and the
   PyPI name; registry accounts and credentials, which only the owner can create.
2. **Dump by running, or static analysis, for Go and Python.** The recommendation is dump by running with
   explicit grants. Static analysis per language needs a type checker in that language (Go can use
   `go/types` through `golang.org/x/tools/go/packages` in the user's build; Python has no equivalent) and finds
   only direct calls on declared stores.
3. **The settings mechanism** for non-TypeScript functions (environment variables or a config field), and
   whether a router that uses `jwtAuth` may hold non-TypeScript functions before a verifying runtime exists.
4. **Handler declaration in Go and Python:** the shape of a route that names an artifact, and whether handler
   source is also located so that `generate` can report environment variables the way `local.env` does for
   TypeScript.
5. **The TypeScript generator's packaging** once the TypeScript CLI is removed: Node or Bun on the user's
   machine, or a compiled binary.
6. **The Go version** the binary requires, and the module path, settled before step 1.
