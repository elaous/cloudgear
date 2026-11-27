# A Go cloudgear CLI

Status: proposal. Nothing in this document is built. It records what the owner decided, turns the decision
into an architecture and a port plan, and lists what is still open. It supersedes the choice between designs
A, B and C in polymorph's `docs/foreign-handlers.md`.

## What the owner decided

- The setup is written once, in a `.polymorph` file. `polymorph gen` writes `setup.ts`, `setup.go` or
  `setup.py`; a TypeScript project uses the TypeScript library, a Go project the Go library, a Python project
  the Python library, and the generated setup imports that language's cloudgear library and drivers.
- The CLI is a Go program that uses polymorph, and applies changes as the TypeScript CLI does today. The
  reason is distribution: a Go binary is better than a tree of `node_modules`.
- The CLI lives in the cloudgear repository as a new Go module. The TypeScript CLI stays until the Go CLI
  reaches parity and is then removed.
- The state format stays compatible: `plan` on an existing deployment MUST show no change. The CLI reads
  the `.polymorph` file directly, and `cloudgear.prototxt` is dropped.
- The user builds the handler artifacts (a Go binary zip, a Python zip, a TypeScript bundle) before `apply`;
  the CLI hashes, checks and uploads them. It needs no Go, Python or Bun toolchain.
- Permissions come from an analyzer written in Go.

## Architecture

```
.polymorph ──> polymorph (eval, check)           ──> setup.ts / setup.go / setup.py   (generated, per language)
      │                                                    │ imports the language's cloudgear library
      └──> cloudgear (Go): model ─> plan ─> apply ─> state ◄── handler artifacts built by the user
                          ▲
                          └─ analyzer: permissions from the handler's calls (and `access` lists)
```

- **Model.** A Go port of what `generate.ts` derives from the analyzer today: physical names and clash
  checks, option serialization and validation (`providers.ts`), certificate `usage`, the API domain,
  `CLOUDGEAR_BLOB_<NAME>` and the other variables that name a resource, secret bindings, schedules, event
  triggers. It reads polymorph's evaluated, schema-checked result, which already carries the setup's
  resources, references and `env` values, and replaces the analyzer's front end and `cloudgear.prototxt`.
- **Plan and apply.** A port of `plan.ts`, `apply.ts`, `adopt.ts`, `protect.ts`, the state store
  (`.cloudgear/state.json`, the S3 state and lock, `state pull/push/unlock/show`) and the commands of `cli.ts`.
- **Drivers.** The AWS drivers (S3 and sites, Lambda, IAM, ACM, CloudFront, API Gateway, EventBridge, ECR,
  Kinesis, ElastiCache, EC2, SSM and Secrets Manager, Route 53), the GCP drivers (GCS, Cloud Functions, Cloud CDN,
  Certificate Manager), Neon, and the Gandi DNS driver, on the Go SDKs. The finished-zip Lambda path of
  cloudgear PR 107 is the one the Go CLI uses for every language, TypeScript included.
- **Libraries.** `polymorph/runtime` and `python/` already hold the blob and secrets clients. The setup each
  generator writes imports its language's library (see the open questions), so that `s.Uploads` is a usable
  client and not only a description.

## Compatibility is the hard part

State holds, per resource, a `spec` object whose keys and values are exactly what the TypeScript planner
produced (`FunctionComparable`, the CDN and certificate specs, site settings), compared by canonical JSON.
The Go planner MUST produce the same specs, with the same keys omitted when unset, or every existing
deployment plans a change. So the port is driven by a conformance suite, written first:

1. Golden states and configs: for each fixture the repository's tests build (deploy, edge, api, gcp, cache,
   registry, instance, events, policies), the TypeScript planner's `desired` entries are exported as JSON.
2. The Go planner, given the same model, MUST produce byte-identical entries after key sorting; the Go driver
   tests run the same fake-cloud scenarios as the TypeScript ones.
3. A state file written by the TypeScript CLI MUST load, plan as no change in Go, and a Go apply MUST leave a
   state the TypeScript CLI also reads, for as long as both exist.

## Port plan

Each step is a pull request with an independent review, and the TypeScript CLI keeps working throughout.

1. **Module and conformance harness.** The Go module, the state types and file store (including the S3
   store with its lock), the fixture export from the TypeScript side, and the comparison test.
2. **Model and plan for resources, certificates, CDNs and API domains** (no functions), against the
   conformance fixtures; `plan`, `check-dns`, `state`.
3. **AWS drivers and `apply`/`destroy`/`import`** in the order the dependencies run: S3 and sites, certificates
   and DNS, CloudFront, API Gateway, then the rest; GCP and Neon after.
4. **Functions:** the model's function derivation, finished-zip Lambda upload, permissions from declared
   `access`, secrets, schedules and event triggers.
5. **The analyzer** (below), then `--permissions`.
6. **Generators import the libraries** (below), the functions runtime libraries for Go and Python, and the
   CLI's remaining commands (`secrets`, `invalidate`, `dump-distributions`).
7. **Removal of the TypeScript CLI,** when every fixture matches and a live deployment has been moved over by
   the owner.

## Open questions

1. **polymorph is a private repository and cloudgear is public.** A Go module in cloudgear that imports
   `github.com/elaous/polymorph` cannot be built by the public CI, or by anyone else, without access to it.
   The owner MUST decide: make polymorph public, move the shared packages (`eval`, `schema`, `syntax`, the
   generators) into the cloudgear repository, or keep the CLI where polymorph is. Until then step 1 can
   vendor a pinned copy for local work only.
2. **What the Go analyzer reads.** A Go analyzer for Go handlers is natural (`go/types` resolves the calls on
   a store handle). TypeScript and Python handlers have no such type checker in Go: a syntax-level analyzer
   (pure-Go parsers, calls on stores that the setup declared) finds direct calls but not stores passed on or
   `client()` use, and the TypeScript analyzer's behavior today (grant everything and warn) is the fallback.
   The owner SHOULD confirm that, for TypeScript and Python, `access` lists in the `.polymorph` file stay the
   rule, with the analyzer only checking them against the calls it can see.
3. **Generated setups that import the library.** Today `gen go` and `gen py` write dependency-free values, and
   `docs/go-runtime.md` says generated setup packages MUST NOT import the library. The decision reverses
   that: the setup imports it, so the generators MUST write library constructors (for Go,
   `blob.New(...)`-style values the generated `Setup` holds) and the library MUST NOT import generated code.
   This changes the golden files and every consumer of `Location()`. The owner SHOULD confirm.
4. **Module and package names,** and the Go version the CLI requires (the polymorph module is on `go 1.24`).
5. **A TypeScript project's deploy loop.** The user builds the TypeScript bundle before `apply`; whether
   cloudgear ships a `bun build` recipe, or a small `cloudgear-bundle` helper, is not decided.
