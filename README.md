# cloudgear

Write an HTTP API as plain TypeScript functions, and cloudgear infers the
cloud infrastructure for it: one serverless function per routed function,
the storage those functions use, and the least-privilege permissions
between them. Think Terraform, but the config is derived from your code.

```sh
bun install
cloudgear generate main.ts   # analyze the app -> cloudgear.prototxt + function bundles
cloudgear plan               # diff the config against .cloudgear/state.json
cloudgear apply              # create/update/delete cloud resources
cloudgear import <name> [id] # adopt an existing resource instead of creating it
cloudgear destroy            # tear down everything cloudgear created
```

(`bun src/cli.ts <command>` inside this repo.) See `examples/router-app` for a
complete app.

## The app

```ts
// main.ts
import { FunctionRouter } from "@cloudgear/functions";
import * as functions from "server/api";

const router = new FunctionRouter("aws", { authenticated: "iam" })
  .url("POST", "/foo/{param}", functions.foo, { name: "createFoo" })
  .url("GET", "/foo/{param}", functions.getFoo);
const urls = router.listen(); // { createFoo: "...", getFoo: "..." }
```

```ts
// server/api.ts
import * as types from "server/types";
import { BlobStore } from "@cloudgear/blob";
import { response } from "@cloudgear/functions";

const store = new BlobStore("aws", "://myblob"); // cloudgear: dry

export async function foo(input: types.FooInput): Promise<types.FooOutput> {
  await store.put(`foo/${input.param}.json`, { name: input.name });
  return { timestamp: new Date() };
}

export async function getFoo(input: types.GetFooInput) {
  return (await store.getJson(`foo/${input.param}.json`)) ?? response({ error: "not found" }, { status: 404 });
}
```

Each routed function receives a single input object built from the request:
JSON/form body fields, then query params, then path params (later sources win
on name clashes). A non-object body is passed as `input.body`. The return
value is sent as JSON; return `response(body, { status, headers })` to control
the status or headers. Thrown errors are logged and answered with a generic
`500 {"error": "Internal Server Error"}`.

`.url()` type-checks route path params against the function's input type, so
`.url("GET", "/x/{id}", fn)` fails to compile when `fn`'s input has no `id`.

### Runtime: `FunctionRouter`

`new FunctionRouter(provider, options)` takes `authenticated: "iam" | "none"`
(default `"iam"`; see Authentication), plus `credentials`, `region`,
`rateLimit` and `mode`. `cloudgear generate` reads `authenticated`, so it MUST
be a string literal inside an object literal.

`.url(method, path, fn, options?)` takes an optional `{ name }`, the route's
nickname. Without one the name is the function's name (`fn.name`), or
`"METHOD /path"` for anonymous functions. Names MUST be unique per router, so
a function mounted on two routes needs `{ name }` on at least one of them.

`router.listen(port)` serves the routes with `Bun.serve` (`router.fetch` is
exposed to mount elsewhere) and returns each route's URL by name. `urls()`
returns the same map later, and `stop()` shuts the server down. In remote mode
the URLs are the deployed function URLs plus the route path (with `"iam"`
only signed calls can use them, so they are not links to hand to browsers); in
local mode they are this server's. Remote mode without deployed endpoints
throws. Path params stay as `{placeholders}`. For each
request the router either:

- **remote**: POSTs the input object to the route's deployed function URL
  (content type `application/vnd.cloudgear.invoke+json`) and relays the
  response. Function URLs come from `.cloudgear/endpoints.json` (found by
  searching up from the working directory to the nearest `package.json`),
  written by `cloudgear apply`, or from `$CLOUDGEAR_ENDPOINTS` (JSON) or
  `$CLOUDGEAR_ENDPOINTS_FILE`. A file with no routes, as left by `destroy`,
  means local mode.
- **local**: runs the function in-process. This is the default when no
  endpoints file exists, so `bun main.ts` works before anything is deployed.
  Force a mode with `new FunctionRouter("aws", { mode: "local" | "remote" })`.

#### Authentication

`authenticated: "iam"` (the default) deploys function URLs with
`AuthType: AWS_IAM`. `authenticated: "none"` deploys public URLs that anyone
can invoke, and `cloudgear generate` warns about it; `--invoker` is ignored
then. With `"iam"`, AWS rejects any request that
is not SigV4-signed by an allowed IAM principal before the function runs, so
unauthenticated traffic is never billed. In remote mode the router signs
each call with AWS credentials (service `lambda`, region taken from the
function URL's host). Credentials come from the standard AWS provider chain,
or from the `credentials` option:

```ts
new FunctionRouter("aws", {
  // a function returning { accessKeyId, secretAccessKey, sessionToken? }
  credentials: myCredentialsProvider,
  region: "eu-west-1", // only needed for URLs that are not *.lambda-url.<region>.on.aws
});
```

Whoever runs the router needs credentials, and its IAM principal MUST be
allowed to call the functions, either by naming it at generate time or by an
identity policy on it:

```sh
cloudgear generate main.ts --invoker arn:aws:iam::123456789012:role/my-app
# or attach lambda:InvokeFunctionUrl on the function ARNs to the caller's own policy
```

`--invoker` takes an IAM role or user ARN, or a 12-digit account id, and is
repeatable. It adds a resource policy on each function; without it nobody but
principals with their own identity policy can call them.

Where the router runs:

- **Vercel (or any host outside AWS).** Browsers cannot sign requests, so
  frontend code calls your app (the router), never Lambda directly. Give the
  app AWS credentials with the least standing access: Vercel's OIDC
  federation into an IAM role is preferable to long-lived access keys (see
  Vercel's AWS OIDC documentation), and pass its credentials provider as
  `credentials`. Name that role with `--invoker`.
- **AWS (ECS, Lambda, EC2).** The default provider chain works; name the
  task or instance role with `--invoker`.
- **Static frontend on S3 behind CloudFront.** The page calls your app's
  URL, which runs the router. Calling the function URLs straight from
  CloudFront is possible later with an origin access control for Lambda URLs;
  that comes with the CDN support, not with this release.

#### End-user authentication

IAM authenticates the router to the functions; to know which *user* is
calling the router, give it an `authenticate` hook. Every route requires it
unless the route is `{ public: true }`:

```ts
import { FunctionRouter, jwtAuth } from "@cloudgear/functions";

const router = new FunctionRouter("aws", {
  authenticate: jwtAuth({
    issuer: "https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_abc123", // or Clerk, Auth0, ...
    audience: "my-app-client-id",
  }),
})
  .url("GET", "/me", functions.me)
  .url("GET", "/health", functions.health, { public: true });

export function me(input: unknown, context: RequestContext) {
  return { user: context.auth?.subject };
}
```

`jwtAuth` verifies `Authorization: Bearer <jwt>` against the issuer's JWKS
(`<issuer>/.well-known/jwks.json`, or `jwksUri`), accepts only asymmetric
algorithms, and checks issuer, expiry and, when given, audience. Always set
`audience`: without it any token from the issuer is accepted. Missing or
invalid tokens get `401`; an unreachable JWKS endpoint gets `503`. Write your
own with `authenticate: (req) => Principal | null`, where a `Principal` is
`{ subject, claims }`.

Functions receive the result as the second argument, `context.auth`. The
router sends it inside the SigV4-signed call, and a function trusts it only
when `authenticated` is `"iam"`: with public URLs anyone could forge it, so
the adapter ignores it and `generate` warns if `authenticate` is set.
Everything you name with `--invoker` is trusted to assert identities.

Limits: `--reserved-concurrency <n>` caps each function's concurrent
executions (applied to every function; `0`/omitted leaves it unreserved).
Use it with care on new AWS accounts, whose total concurrency limit can be
very low. The router can also rate limit callers:

```ts
new FunctionRouter("aws", {
  rateLimit: { limit: 100, windowMs: 60_000, key: (req) => userIdFrom(req) },
});
```

Requests over the limit get `429` with `Retry-After`. Counters live in each
process's memory, so a serverless app with many instances enforces the limit
per instance; use it as a coarse guard, not as a quota. At most 10,000
clients are tracked and the oldest counters are dropped first, so flooding
with fake identities cannot exhaust memory (it can make a limited client's
counter reset). You MUST give a `key(req)` function or set `trustProxy: true`,
which takes the first `X-Forwarded-For` address; enable that only behind a
proxy that sets or overwrites the header, because otherwise clients choose
their own identity.

### Runtime: `BlobStore`

`BlobStore` is a provider-neutral wrapper. It parses the URI, resolves the
physical location and implements the common methods (`get`, `getText`,
`getJson`, `exists`, `put`, `delete`, `list`) on top of a `BlobDriver`:

```ts
interface BlobDriver {
  get(key): Promise<Uint8Array | null>;
  put(key, data, contentType?): Promise<void>;
  delete(key): Promise<void>;
  list(prefix): Promise<string[]>;
  exists(key): Promise<boolean>;
}
```

`new BlobStore(provider, uri, { path })` confines a store to a key prefix
(`path: "/img-cache/"`): every key is stored under `img-cache/`, `list()`
strips it again, and `cloudgear generate` scopes the function's IAM policy to
that prefix (object access to `bucket/img-cache/*`, listing with an
`s3:prefix` condition). Two stores may share a bucket with different paths.
`path` MUST be a string literal. On AWS, a missing key in a prefix-scoped
store may surface as `AccessDenied` instead of `null`, because S3 only
answers "not found" to callers that can list the whole bucket; this has not
been checked against a real bucket.

Drivers live in `packages/blob/drivers/` and load on first use, so an app
only imports the SDK of the provider it uses. `aws` (`drivers/s3.ts`, needs
`@aws-sdk/client-s3`) is built in; add another with
`registerBlobDriver("gcp", (location) => new MyGcsDriver(location))`.
`uri` is `"://name"` or `"<scheme>://name"` (the scheme MUST match the
provider: `s3`, `gs`, `az`). `CLOUDGEAR_BLOB_DRIVER=memory` swaps in an
in-memory driver for local runs and tests.

Deployed functions find the physical store through the env var
`BlobStore.envVarFor(name)` (`CLOUDGEAR_BLOB_<NAME>`), which `cloudgear
generate` writes into the config and `BlobStore.location` reads.

## `cloudgear generate`

Parses the app with the TypeScript compiler (it never executes it) starting
from the entry file and following imports:

| In code | Inferred (aws) |
| --- | --- |
| `new FunctionRouter("aws").url(method, path, fn)` | one `@aws.Lambda` per distinct `fn`, behind an IAM-protected function URL |
| `new BlobStore("aws", "://myblob")` | `@aws.S3` bucket `myblob` |
| `store.get/getText/getJson(...)` inside `fn` | `s3:GetObject`, `s3:ListBucket` (S3 answers 403 instead of "not found" without it) |
| `store.exists(...)` | `s3:GetObject`, `s3:ListBucket` |
| `store.put(...)` | `s3:PutObject` |
| `store.delete(...)` | `s3:DeleteObject` |
| `store.list(...)` | `s3:ListBucket` |

`BlobStore` methods map to provider-neutral accesses (`read`, `write`,
`delete`, `list`) in `BLOB_OPERATIONS`; `src/providers.ts` maps those to each
provider's permissions.

Permissions are traced per function through every local function, method,
constructor and variable initializer it reaches, across files. A store
passed around as a value (an argument, an alias) gets every operation
granted, with a warning. A store used at module level, outside any
function, gets no inferred permission and a warning.

For access the analyzer cannot trace, declare it inside the function:

```ts
import { BlobStore, grant } from "@cloudgear/blob";

export async function viaRepo() {
  grant(store, "read"); // "read" | "write" | "delete" | "list"; a no-op at runtime
  return repo.read(); // store reaches repo through a constructor
}
```

When a function calls `grant(store, ...)`, that store is no longer widened
to every operation for being passed around; the granted accesses (plus any
direct calls) are used instead.

Requirements the analyzer enforces:

- Exactly one `FunctionRouter` per app; provider, method and path MUST be
  string literals. `.url(...)` calls MUST be on the router variable or a
  chain from it (variables holding a chain result are followed); passing
  the router to a function, or exporting it, is rejected.
- A routed function MUST be a named, exported function (declaration or
  `const` arrow) in your project, or a method of an exported object
  (`export const local = { getObjects(input) { ... } }`), so it can be
  bundled on its own. Methods are bundled bound to their object, so `this`
  works. The routed function may share a module with the router: inside
  Lambda `listen()` does nothing.
- `new BlobStore(...)` MUST be assigned to a variable, with literal arguments
  (including the options' `path`), and use the router's provider.

Directives go in a comment on the declaration line or the line above it:

- `// cloudgear: dry`: the resource already exists; cloudgear never creates,
  updates or deletes it. Its physical name is the URI name.

Each function is bundled with `Bun.build` into
`.cloudgear/build/<name>/index.mjs`: the function's module, its whole import
tree and the `node_modules` it reaches, wrapped in the provider's handler
adapter. Bundles target the Node.js Lambda runtime.

The output is `cloudgear.prototxt`, protobuf text format for the
`cloudgear.Config` message in `src/config/cloudgear.proto`:

```
project: "router-app"
provider: "aws"
resource {
  name: "myblob"
  type: "@aws.S3"
  physical_name: "myblob"
  dry: true
  source: "server/api.ts:6"
}
function {
  name: "foo"
  type: "@aws.Lambda"
  physical_name: "router-app-foo"
  runtime: "nodejs22.x"
  memory_mb: 256
  timeout_s: 10
  source { file: "server/api.ts" export: "foo" input_type: "types.FooInput" }
  route { method: "POST" path: "/foo/{param}" }
  bundle { path: ".cloudgear/build/foo/index.mjs" sha256: "..." }
  permission { resource: "myblob" action: "s3:PutObject" }
  env { key: "CLOUDGEAR_BLOB_MYBLOB" value_from: "myblob" }
}
```

## `cloudgear plan` / `apply` / `destroy`

State lives in `.cloudgear/state.json` next to the config. `plan` compares
the config to state:

```
      = @aws.S3 myblob (dry: assumed to exist, not managed)
      + @aws.S3 cloudgear-example-archive
      + @aws.Lambda foo
      ~ @aws.Lambda getFoo (code, permissions)
```

Function updates are split into `code` (bundle hash), `config` (runtime,
memory, timeout, env) and `permissions`, and only the affected API calls are
made. Changing a physical name is a replace. `apply` asks for confirmation
(skip with `--auto-approve`), saves state after every step so a failure keeps
what succeeded, and writes `.cloudgear/endpoints.json` for the router.

If a deploy step fails part-way through creating a function, what that call
created is rolled back. Deleting a bucket that still has objects fails with a
message instead of emptying it.

On AWS each function gets an IAM role (`AWSLambdaBasicExecutionRole` plus an
inline policy with the inferred S3 permissions), a Lambda function and a
function URL with `AuthType: AWS_IAM`. Region comes from `--region`,
`$AWS_REGION` or `$AWS_DEFAULT_REGION`; credentials from the standard AWS SDK
chain.

## `cloudgear import`

`cloudgear import myblob my-existing-bucket` records a config resource as
already existing under the given physical name (default: its configured
name). Imported resources are never created or deleted (`destroy` only
forgets them), and functions that use them get that physical name in their
env and IAM policy.

## Code map

Where each moving part lives, since several are called across packages:

| Name | Defined in | Used by |
| --- | --- | --- |
| `BlobStore`, `BLOB_OPERATIONS`, `BlobStore.envVarFor` | `packages/blob/index.ts` | apps; `src/analyze/app.ts` (method to access); `src/generate.ts` (env var) |
| `registerBlobDriver`, `parseBlobUri` | `packages/blob/driver.ts` | `BlobStore`; custom drivers |
| `FunctionRouter`, `request` | `packages/functions/router.ts` | apps |
| `response`, input assembly (`buildInput`, `compilePath`) | `packages/functions/http.ts` | router and Lambda adapter |
| `createHandler` | `packages/functions/drivers/aws.ts` | bundle entry generated in `src/build/bundle.ts` |
| `signFunctionUrlRequest` | `packages/functions/sign.ts` | `FunctionRouter` remote calls |
| `jwtAuth`, `Authenticator` | `packages/functions/auth.ts` | apps (`authenticate` option) |
| `grant`, `normalizeBlobPath` | `packages/blob/index.ts` | apps; `src/analyze/app.ts` |
| `analyzeApp` | `src/analyze/app.ts` | `src/generate.ts` |
| `providerProfile` (service types, permissions) | `src/providers.ts` | `src/generate.ts` |
| `encodeConfig` / `decodeConfig`, prototxt codec | `src/config/` | `generate`, `plan`, `apply` |
| `plan`, `apply`, `endpointsFrom` | `src/deploy/` | `src/cli.ts` |
| `awsDrivers` | `src/deploy/aws/index.ts` | `src/cli.ts` |

## Status

Early draft. Only the `aws` provider has inference rules and deploy drivers;
`BlobStore` is the only resource client. Function URLs are IAM-protected, so
the router needs AWS credentials (see Authentication); end-user
authentication is not part of the router yet. Input objects are not
validated against their TypeScript types at runtime.
