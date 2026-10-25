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

const router = new FunctionRouter("aws")
  .add("POST", "/foo/{param}", functions.foo)
  .add("GET", "/foo/{param}", functions.getFoo);
router.listen();
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
the status or headers. Thrown errors become `500 {"error": message}`.

`.add()` type-checks route path params against the function's input type, so
`.add("GET", "/x/{id}", fn)` fails to compile when `fn`'s input has no `id`.

### Runtime: `FunctionRouter`

`router.listen(port)` serves the routes with `Bun.serve` (`router.fetch` is
exposed to mount elsewhere). For each request it either:

- **remote**: POSTs the input object to the route's deployed function URL
  (content type `application/vnd.cloudgear.invoke+json`) and relays the
  response. Function URLs come from `.cloudgear/endpoints.json`, written by
  `cloudgear apply`, or from `$CLOUDGEAR_ENDPOINTS` (JSON) or
  `$CLOUDGEAR_ENDPOINTS_FILE`.
- **local**: runs the function in-process. This is the default when no
  endpoints file exists, so `bun main.ts` works before anything is deployed.
  Force a mode with `new FunctionRouter("aws", { mode: "local" | "remote" })`.

A deployed function also accepts direct HTTP calls on its own URL
(`GET https://<fn-url>/foo/42?q=x`); it matches its routes and builds the
same input object.

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
| `new FunctionRouter("aws").add(method, path, fn)` | one `@aws.Lambda` per distinct `fn`, behind a public function URL |
| `new BlobStore("aws", "://myblob")` | `@aws.S3` bucket `myblob` |
| `store.get/getText/getJson(...)` inside `fn` | `s3:GetObject` |
| `store.exists(...)` | `s3:GetObject`, `s3:ListBucket` |
| `store.put(...)` | `s3:PutObject` |
| `store.delete(...)` | `s3:DeleteObject` |
| `store.list(...)` | `s3:ListBucket` |

`BlobStore` methods map to provider-neutral accesses (`read`, `write`,
`delete`, `list`) in `BLOB_OPERATIONS`; `src/providers.ts` maps those to each
provider's permissions.

Permissions are traced per function through every local helper it calls,
across files. A store passed around as a value (for example as an argument)
gets every operation granted, with a warning.

Requirements the analyzer enforces:

- Exactly one `FunctionRouter` per app; provider, method and path MUST be
  string literals.
- A routed function MUST be a named, exported function (declaration or
  `const` arrow) in your project, so it can be bundled on its own.
- `new BlobStore(...)` MUST be assigned to a variable, with literal arguments,
  and use the router's provider.

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

On AWS each function gets an IAM role (`AWSLambdaBasicExecutionRole` plus an
inline policy with the inferred S3 permissions), a Lambda function and a
function URL with `AuthType: NONE`. Region comes from `--region`,
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
| `createHandler` | `packages/functions/aws.ts` | bundle entry generated in `src/build/bundle.ts` |
| `analyzeApp` | `src/analyze/app.ts` | `src/generate.ts` |
| `providerProfile` (service types, permissions) | `src/providers.ts` | `src/generate.ts` |
| `encodeConfig` / `decodeConfig`, prototxt codec | `src/config/` | `generate`, `plan`, `apply` |
| `plan`, `apply`, `endpointsFrom` | `src/deploy/` | `src/cli.ts` |
| `awsDrivers` | `src/deploy/aws/index.ts` | `src/cli.ts` |

## Status

Early draft. Only the `aws` provider has inference rules and deploy drivers;
`BlobStore` is the only resource client. Function URLs are public
(`AuthType: NONE`). Input objects are not validated against their TypeScript
types at runtime.

## Legacy: CDK shorthand

`bun factory.ts <source-file.ts> [outDir]` still compiles the original
`new aws.Lambda("name", "./src")` / `new aws.DynamoTable("name")` shorthand
into an AWS CDK stack via `plugins/<ResourceType>.ts`. See
`examples/api-stack.ts`.
