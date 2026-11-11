# cloudgear

Write your HTTP API in TypeScript and cloudgear plans the cloud infrastructure from it, reviewable before you apply.

Write an HTTP API as plain TypeScript functions, and cloudgear infers the
cloud infrastructure for it: one serverless function per routed function,
the storage those functions use, and the least-privilege permissions
between them. Think Terraform, but the config is derived from your code.

## Requirements

- [Bun](https://bun.sh) 1.x runs the CLI, the router and the tests (the
  repository is developed against Bun 1.4).
- An AWS account and credentials from the standard AWS provider chain, only for
  `apply`, `import`, `destroy`, `invalidate` and `secrets`; `generate`, `plan`
  (which compares the config with the state file and calls no cloud API) and
  local runs need none.
- Deployed functions run on Node.js 22 (`nodejs22.x` on Lambda).

## Install

cloudgear is not published to a package registry yet. Clone the repository and
link the CLI:

```sh
git clone https://github.com/elaous/cloudgear.git
cd cloudgear
bun install
bun link          # puts `cloudgear` on your PATH (~/.bun/bin)
```

Without linking, run `bun src/cli.ts <command>` from the repository root.

## Usage

```sh
cloudgear generate main.ts   # analyze the app -> cloudgear.prototxt + function bundles
cloudgear plan               # diff the config against .cloudgear/state.json
cloudgear apply              # create/update/delete cloud resources
cloudgear import <name> [id] # adopt an existing resource instead of creating it
cloudgear invalidate [path]  # clear the CDN's cache
cloudgear destroy            # tear down everything cloudgear created
cloudgear secrets set|list   # store and check the secrets the app declares
```

`cloudgear --help` prints the commands and options. `generate` writes the
config (`cloudgear.prototxt`) and `cloudgear.env.json`, and the function
bundles under `.cloudgear/build/`; `apply` keeps `.cloudgear/state.json` and
`.cloudgear/endpoints.json` next to the config. Try it on the example app:

```sh
cd examples/router-app
cloudgear generate main.ts   # 3 functions, 2 resources
cloudgear plan               # nothing is created; needs no AWS credentials
```

Options (the command an option applies to is in parentheses):

| Option | Meaning |
| --- | --- |
| `--config <file>` | Config file (default `cloudgear.prototxt`); `.cloudgear/` sits next to it |
| `--project <name>` | Project name that prefixes function names (`generate`; default: the `name` in the entry's `package.json`, else its directory name) |
| `--invoker <arn>` | IAM principal allowed to call the functions (`generate`, repeatable; see Authentication) |
| `--reserved-concurrency <n>` | Cap each function's concurrent executions (`generate`) |
| `--region <region>` | Cloud region (default `$AWS_REGION` or `$AWS_DEFAULT_REGION`) |
| `--env <name>`, `--author <name>`, `--tag <key=value>` | Tags on created resources (`apply`; `import` accepts them but adds no tags; see Tags) |
| `--auto-approve` | Skip the confirmation prompt (`apply`, `destroy`) |
| `--skip-env-check` | Deploy even if a variable or secret is missing (`apply`) |
| `--domain <cdn domain>` | Which CDN to invalidate when the app has several (`invalidate`) |
| `--arn <arn>`, `--all` | What `import` adopts (see `cloudgear import`) |
| `--from-envfile <file>`, `--allow-unignored`, `--path <path>`, `--all` | Options of `secrets set` (see Secrets) |

See `examples/router-app` for a complete app and `examples/cdn-app` for one with
domains and a CDN.

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

Instead of a function, the third argument MAY be the path of a script file whose
default export is the handler:

```ts
new FunctionRouter("aws")
  .url("GET", "/hello", "./handlers/hello.ts")
  .url("POST", "/items/{id}", "./handlers/save.ts", { name: "saveItem" });
```

```ts
// handlers/save.ts
export default async function ({ id }: { id: string }) {
  return { id };
}
```

The path MUST be a string literal. `./x` and `../x` are relative to the file
that calls `.url`, like an import; `/x` and `x` start at the project root, the
directory of the nearest `package.json`. `generate` analyzes the script like any
routed function (its `BlobStore` use, `@policy` and input type) and bundles it
on its own. The function is named after the script's path from the project root
(`/api/v/[slug].ts` is `api-v-slug`). Because the router cannot see the
script's types, route params are checked by `generate` and not by the compiler,
and a route without `{ name }` is named `"METHOD /path"`. In local mode the
router imports the script on its first request and answers 500 if it fails to
load or has no default function. A `./x` path is relative to the file that calls
`.url` at run time too, so `.url` MUST be called from the file the path is
written for, and not through a helper in another file.

#### Request, response and files

A function that does not import cloudgear can still get a Vercel-style request
and a response writer, and files, through the route's options:

```ts
import { FunctionRouter, VercelResponse } from "@cloudgear/functions";

new FunctionRouter("aws").url("GET", "/v/{slug}", "/api/v/[slug].ts", {
  include: "dist/index.html",
  request: true,
  response: VercelResponse,
});
```

```ts
// api/v/[slug].ts
import fs from "node:fs";

export default async function (request, response) {
  response.status(200).json({ slug: request.query.slug, html: fs.readFileSync("dist/index.html", "utf8") });
}
```

- `request: true` (default `false`) hands the function a request like
  `IncomingMessage & { query, cookies, body }` instead of its input. `query`
  holds the query string and the path params, `cookies` the parsed cookies and
  `body` the parsed body (JSON and form bodies as objects, anything else as
  text). The request is also a readable stream of the raw body.
- `response` (default none) is given as the import itself, and the function
  receives it after its first argument: `response`, the helper (the function
  returns its output, as usual, built with `response(body, { status, headers })`),
  or `VercelResponse`, a writer like `ServerResponse & { send, json, status,
  redirect }` (the function writes to it and returns nothing; a returned value
  is used only if nothing was written, and the writer MUST be ended, since the
  response waits for it). The writer supports `setHeader`,
  `getHeader`, `removeHeader`, `writeHead`, `write`, `end`, `send`, `json`,
  `status` and `redirect`; text and JSON bodies are sent as text, any other
  content type as base64, and several `Set-Cookie` values stay separate.
- So the arguments are `(request or input, response?, context)`. Without
  `request` the function takes its input, and `generate` checks the route's path
  params against its type; with `request` it does not, since they are in
  `request.query`.
- `include` is a file, a directory (all its files) or an array of them, from the
  project root, that MUST exist when `generate` runs. They are packaged with
  the function at the same relative paths, so the function reads them relative
  to its working directory (`dist/index.html` above); in local mode that is the
  process's working directory, so the app SHOULD start from the project root.
  They are part of the bundle's hash, so a change redeploys the function. An
  `include` MUST NOT leave the project, contain a symbolic link, be the project
  root, `.cloudgear` or `index.mjs`. `generate` refuses more than 250 MB
  (Lambda's unzipped limit) and warns above 40 MB, since Lambda takes a zipped
  package of up to 50 MB directly.
- All routes of one function MUST give the same `include`, `request` and
  `response`. They are not available for providers other than `aws` yet.
- Behind the router in remote mode, the router forwards the original request
  (method, URL, headers and body) to a function that asked for it, including
  its credential headers (`authorization`, `cookie`, the token header). The
  function trusts that request only when it trusts the router, that is with
  `authenticated: "iam"` and no `cert` or CDN; otherwise, and when called
  directly through a cert or a CDN, the request is rebuilt from the Function
  URL event (its cookies joined into `cookie`), so its host is the function
  URL's and not the viewer's. A Lambda payload is limited to 6 MB, and a
  forwarded body travels twice, as input and in the request. A scheduled run
  gets a synthetic `POST https://schedule.invalid/` request whose body is the
  schedule input.

### Runtime: `FunctionRouter`

`new FunctionRouter(provider, options)` takes `authenticated: "iam" | "none"`
(default `"iam"` for `aws`; see Authentication), plus `credentials`, `region`,
`authenticate`, `cert`, `rateLimit`, `mode`, `functionOptions`, `optionalEnv`,
`env`, `endpoints` and `endpointsFile`. `cloudgear generate` reads
`authenticated`, `authenticate`, `region`, `cert`, `functionOptions`,
`optionalEnv` and `env` without running your code, so the options MUST be an
object literal without spread, and `authenticated`, `region`,
`functionOptions` and `optionalEnv` MUST be literals.

`.url(method, path, fn, options?)` takes an optional `{ name }`, the route's
nickname. Without one the name is the function's name (`fn.name`), or
`"METHOD /path"` for anonymous functions. Names MUST be unique per router, so
a function mounted on two routes needs `{ name }` on at least one of them.

`router.listen(port)` serves the routes with `Bun.serve` (`port` defaults to
`$PORT`, else 3000; `router.fetch` is exposed to mount elsewhere) and returns each route's URL by name. `urls()`
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
  `$CLOUDGEAR_ENDPOINTS_FILE`. A file with no routes means local mode, and `destroy`
  deletes the file.
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

`--invoker` takes an IAM role or user ARN, an account root ARN, or a 12-digit
account id, and is repeatable. It adds a resource policy on each function; without it nobody but
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
- **Static frontend on S3 behind CloudFront.** The page calls the router's own
  domain (a `Cert` handed to `FunctionRouter`, served through API Gateway; see
  Domains), or your app's URL that runs the router.

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

`jwtAuth` verifies `Authorization: Bearer <jwt>` (or the bare token in
`header`, see Identity on the API domain) against the issuer's JWKS
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

### Domains: certificates, CDN and API

A site and an API each get a domain of their own. Declare a `DNS` and a `Cert`
per domain, give one `Cert` to a `CDN` for the static site and another to the
router for its routes:

```ts
import { BlobStore } from "@cloudgear/blob";
import { DNS } from "@cloudgear/dns";
import { CDN, Cert } from "@cloudgear/cdn";
import { FunctionRouter } from "@cloudgear/functions";

const site = new BlobStore("aws", "://my-site", { path: "/web" }); // the static files
const siteDns = new DNS("gandi", "www.example.com", { zone: "example.com" });
const siteCert = new Cert("aws", siteDns);
const cdn = new CDN("aws", siteCert, { bucket: site });

const apiDns = new DNS("gandi", "api.example.com", { zone: "example.com" });
const apiCert = new Cert("aws", apiDns);

const router = new FunctionRouter("aws", { cert: apiCert })
  .url("GET", "/objects/{param}", functions.getObjects);
router.listen(); // { getObjects: "https://api.example.com/objects/{param}" }
```

`cloudgear apply` then:

- **Certificates:** requests an ACM certificate per `Cert`, writes its
  validation record through the `Cert`'s `DNS`, and waits until it is issued. A
  CDN's certificate is issued in `us-east-1`, where CloudFront needs it; the
  router's in the function region (the router's `region` option, else
  `--region`), which API Gateway needs.
- **CDN:** creates a CloudFront distribution for the CDN's domain with the
  bucket (under its `path`, if any) as its origin, allows only that
  distribution to read the bucket, and points the domain at it.
- **API:** creates an API Gateway HTTP API with one route per `.url(...)`
  (`GET /objects/{param}` and so on), each integrated with its function (payload
  format 2.0), allows API Gateway to invoke them, adds a `$default` stage, a
  regional custom domain with the router's certificate and an API mapping, and
  points the domain at it.

Deletes run in the opposite order, and a `create` that fails part-way keeps
what it made in state, so the next `apply` resumes from there. Functions keep
their IAM-protected function URLs, which the router uses in remote mode; the
API domain is a second, public way to reach them.

#### Serving the router through a CDN

A `CDN` serves either a `bucket` or a `router`. Passing the router puts its
routes behind CloudFront instead of API Gateway, on a `Cert` of their own:

```ts
const router = new FunctionRouter("aws", { authenticate: jwtAuth({ issuer, header: "x-auth-token" }) })
  .url("GET", "/items", functions.listItems)
  .url("GET", "/items/{id}", functions.getItem);
new CDN("aws", apiCert, { router });
```

`apply` creates a distribution for the CDN's domain whose origins are the
functions' IAM-protected function URLs. It signs requests to them with an origin
access control of type Lambda, adds one behavior per path (`/items/{id}` becomes
`/items/*`, and a literal path also gets its trailing-slash variant), and allows
only that distribution to call each function. Caching is off for these
behaviors, plain HTTP is refused (they are HTTPS only), and a path that matches
no behavior reaches the first function, which answers 404. A site `CDN` and a router `CDN` MAY coexist,
each with its own `Cert`.

| | API Gateway (`cert`) | CDN (`router`) |
| --- | --- | --- |
| Price | about $1 per million requests | within CloudFront's request pricing and free tier |
| Same path, different methods, different functions | supported | refused unless `methodRouting: "function"` |
| Routes | up to 300 | about 25 distinct paths by default (a quota) |
| `POST` and `PUT` from clients | plain requests | MUST send `x-amz-content-sha256`, the SHA-256 hex digest of the body |
| `Authorization` header | passed through | replaced by CloudFront's signature; `jwtAuth` MUST read another header |
| Site and API on one domain | no | no; the CDN serves one or the other |
| Deploy time | seconds | minutes per distribution update |

Route changes reach CloudFront's edges over a few minutes, and requests for the
changed routes MAY get a 404 or a 5xx meanwhile. Moving a domain between `cert`
and a CDN stops at the old CNAME: remove that DNS record first, or use another
domain.

A router MUST NOT have both a `cert` and a CDN. With a CDN, functions are
called directly like with a `cert`: the router's `authenticate` hook and
`rateLimit` do not run (see the rules below), and `authenticated` MUST be
`"iam"`.

CloudFront routes by path only. When different functions serve the same path
for different methods, or a literal path such as `POST /items/new` hides methods
of the param path that covers it (`GET /items/{id}`), `cloudgear generate` stops
and lists the paths with the options. Give those paths one function that handles every method, serve the
router through API Gateway, or set `methodRouting: "function"` on the CDN:

```ts
new CDN("aws", apiCert, { router, methodRouting: "function" });
```

`apply` then publishes a CloudFront Function that picks the function by method
and path on every request (a `HEAD` request goes to the `GET` route unless the
path has a `HEAD` route) and answers 404 for anything else. CloudFront charges
for its invocations (about $0.10 per million after 2 million free a month; check
current pricing) and every request pays a little latency. The function is only
created when some path needs it; otherwise `generate` warns that the option has
no effect.

DNS providers (`new DNS(provider, domain, { zone })`): `"gandi"` (LiveDNS; set
`GANDI_TOKEN` to a personal access token, or the legacy `GANDI_API_KEY`) and
`"aws"` (Route 53; needs a public hosted zone named like the zone, with
credentials from the usual AWS chain). Credentials are read from the
environment when a record is written and are never stored in the config or
state. `zone` defaults to the last two labels of the domain (three for common
suffixes like `co.uk`); set it for anything else, and make it the zone that
actually holds the records (a delegated subzone shadows its parent). Each
state entry remembers its own DNS provider and zone, so removing the
declarations still cleans up through the right zone. A CDN's or router's
domain MUST be a subdomain of its zone, because the apex cannot be a CNAME.
Add a provider with `registerDnsDriver`, like blob drivers.

Rules the analyzer enforces:

- An app MAY declare any number of `DNS` and `Cert`s, one `DNS` per `Cert`,
  each assigned to a variable with literal arguments; two `Cert`s MUST NOT
  cover the same domain. Any number of `CDN`s with a `bucket`, at most one `CDN`
  with a `router`, and at most one router `cert`.
- Two CDNs, including a CDN that serves the router, MUST NOT share a `Cert`
  unless it is a wildcard; each serves its own domain. The router's own `cert`
  (API Gateway) MUST NOT be shared with any CDN and MUST NOT be a wildcard.
- A `Cert` needs neither: declare only `DNS` and `Cert` to get a validated
  certificate (it may then cover the zone apex). `new Cert(provider, dns, {
  region })` sets the region of a certificate that nothing uses; for a CDN it
  MUST be `us-east-1` and for the router it MUST be the function region.
- A `Cert` MAY be a wildcard: `new DNS("gandi", "*.example.com", { zone: "example.com" })`
  and a `Cert` on it. Every CDN on it then names the hostname it serves, one
  label under the wildcard, with the `domain` option
  (`new CDN("aws", wildcard, { bucket: files, domain: "files.example.com" })`),
  so several CDNs, including the router's, share one certificate, validated by a
  single CNAME. Each hostname gets its own distribution alias and CNAME record.
  A wildcard does not cover the apex (`example.com`) or deeper names
  (`a.b.example.com`), and a CDN on an exact `Cert` takes no other `domain`. A
  wildcard `Cert` cannot serve the router through API Gateway (its certificate
  lives in the function region, not us-east-1); use an exact `Cert` there. A
  hostname that already has a foreign record is found when its distribution is
  made, which is after the certificate is issued.
- An app MAY have several CDNs: one per static site, each with its own `Cert`
  (CDNs share a `Cert` only when it is a wildcard) and bucket, for example one for files and images,
  one for the frontend and one for an admin app, plus one more for the router
  (`{ router }`). Several CDNs MAY serve the same bucket, each under its own
  path. Each distribution has its own bucket-policy statement and is removed
  separately.
- `DNS`, `Cert` and `CDN` do nothing at runtime except report what `apply`
  deployed. `cert.status()` asks the provider (ACM, in the `Cert`'s region) and
  returns `{ state: "none" | "pending" | "issued" | "failed", id? }`.
  `cdn.status()` returns the same shape with `none`, `deploying` or `deployed`.
  `await cdn.url()` returns the distribution's own URL
  (`https://d111.cloudfront.net`; the custom domain is `cdn.domain`): it reads
  the entry for its own domain that `apply` writes into `.cloudgear/endpoints.json`
  (`cdn`, or `cdns` by domain once the app has several) and
  otherwise asks the provider (`CloudFront` by alias), and throws until the
  CDN is deployed. Register drivers with `registerCertDriver()` and
  `registerCdnDriver()`, or use `CLOUDGEAR_CERT_DRIVER=memory` and
  `CLOUDGEAR_CDN_DRIVER=memory`. `status()` and `url()` are for the app that
  deploys or serves from the router (a local process or Vercel). Inside a
  Lambda there is no endpoints file and its role cannot list distributions, so
  pass the URL in as configuration there.
- `examples/cdn-app` is a complete app: two domains, a CDN and a routed
  function with a `@policy`.
- A CDN's `router` MUST be the app's `FunctionRouter`, passed as a variable.
  `POST` and `PUT` routes make `generate` warn about the payload hash header.
- Requests on the router's domain reach functions directly, so the router's
  `authenticate` hook and `rateLimit` do not run for them. `generate` refuses
  a router that has a custom `authenticate` unless every route is
  `{ public: true }`, and warns about `rateLimit`. With
  `authenticate: jwtAuth({...})` the functions verify tokens themselves
  (see Identity on the API domain).
- A `dry` bucket is not created or deleted, but the CDN still adds one
  statement to its bucket policy (and removes it again), which `generate`
  warns about. The CDN's bucket policy statement only allows `s3:GetObject`
  under the site's path, for that one distribution; because it cannot list
  the bucket, a missing file is answered with 403 rather than 404. The bucket
  (or its `path`) is public through the CDN, so
  `generate` also warns when a function uses the same files.
- API Gateway routes are `METHOD /path` with `{param}` segments, as in
  `.url`. A route belongs to the one function it is registered with. HTTP APIs
  allow up to 300 routes, and the routes are open (`AuthorizationType: NONE`):
  protect them with `jwtAuth`, or keep the router off the public domain.
- Anyone can reach functions through the API domain with their own requests,
  so functions behind it never trust a caller identity (`context.auth` is not
  populated), and the router's invoke protocol still ignores method and path
  matching there. This is why a custom `authenticate` needs every route to be
  public.

#### Identity on the API domain

With a router `cert` and `authenticate: jwtAuth({...})`, `generate` reads the
literal settings (`issuer`, `audience`, `jwksUri`, `clockToleranceSeconds`,
`header`) and bakes the same verification into each function's bundle. Every
request, whether from a caller of the domain or from the router, then carries a
token that the function checks, and `context.auth` is the verified principal.
Rules:

- `header` defaults to `authorization` (`Bearer <jwt>`), which API Gateway
  passes through. Any other header holds the bare token (a `Bearer ` prefix is
  tolerated); the router forwards a non-`authorization` header on remote calls,
  because `Authorization` carries the router's own signature there.
- Options MUST be string, string-array or number literals.
- A function whose routes are all `{ public: true }` skips verification. A
  function with both public and protected routes is refused: give each its own
  function.
- A bad token gets 401, a JWKS outage 503. Functions still never trust a
  `context` sent in the request.
- HEAD requests are served by the GET route, without a body.

cloudgear never overwrites a DNS record it does not own: if a domain
already has a record pointing elsewhere, `apply` stops before the certificate
is requested, and `destroy` only removes a record while it still points at what
cloudgear created. A certificate's validation record is left in place on
destroy, because ACM shares it between certificates for a domain.

`cloudgear invalidate [path...]` clears a site CDN's cache (`/*` by default); the
router's distribution is not offered. An app with several CDNs needs
`--domain <cdn domain>` to say which one.
Uploading the site's files is not part of cloudgear yet.

Things that have not been checked against real services: all of the
CloudFront, ACM, API Gateway, Route 53 and Gandi calls are tested against
fakes only. The Gandi driver's URLs, authentication, field names, status codes
and TTL bounds were checked against Gandi's published LiveDNS reference
(api.gandi.net/docs/livedns), but never against a live account. The S3 origin
uses the regional bucket domain of the bucket's own `region` (see Regions).

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
`path` MUST be a string literal. `store.url(key?)` returns
`https://<bucket>/<path><key>` for a bucket named after the domain that serves
it (`s3://assets.example.com`). The key's segments are URL-encoded but not
normalized (`a/../b` stays as written), the bucket is its physical name once
deployed, and nothing is requested. A CDN that serves a dotted bucket may fail
its HTTPS connection to S3 (not checked against real AWS); `generate` warns.
On AWS, a missing key in a prefix-scoped store may surface as `AccessDenied` instead of `null`, because S3 only
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

### Scheduled functions

A function can also run on a schedule, with a `cron` template string (standard
five fields, minute hour day-of-month month day-of-week, always UTC), either as
a route option or with the `@schedule` decorator:

```ts
import { FunctionRouter, cron, schedule } from "@cloudgear/functions";

export class Jobs {
  @schedule(cron`0 3 * * *`)
  static async nightly() { /* no route, no URL */ }
}
new FunctionRouter("aws").url("GET", "/report", report, { schedule: cron`*/15 * * * *` });
```

- `@schedule` goes on a method of a class and makes it a function of its own,
  with no route and no function URL. A `static` method needs an exported class;
  an instance method needs exactly one exported instance of its class
  (`export const jobs = new Jobs()`). `@schedule` and the `schedule` option MAY
  be combined and repeated, and an app MAY have no
  routes at all. Both are read by `generate`, so the value MUST be a literal
  `cron` template without `${}`; they do nothing at runtime.
- On AWS each expression becomes an EventBridge rule (`@aws.Schedule`) that
  targets the function, plus a Lambda permission for `events.amazonaws.com`.
  `cron` is converted to EventBridge's six-field form (`*/15 * * * *` becomes
  `cron(0/15 * * * ? *)`). Seconds are not supported, and day-of-month and
  day-of-week MUST NOT both be restricted.
- A schedule MAY carry a query string, for one function that does several jobs
  (as a Vercel cron path like `/api/cron?job=db-backup` does):
  `schedule: [{ cron: cron`27 7 1 * *`, query: { job: "db-backup" } }, ...]`, or the
  same object inside `@schedule(...)`. Names and values MUST be literals using only
  letters, digits and `_ . : / -`. Each one is its own EventBridge rule, so
  changing a query replaces the rule. The run gets the query in its input
  (`{ scheduledTime, rule, query }`), and with `request: true` in `request.query`.
  A scheduled run with a query and `request: true` also looks like a Vercel cron call: its
  `User-Agent` is `vercel-cron/1.0` and, when the function has a `CRON_SECRET`
  environment variable (declare it with `env`, see Secrets), it sends
  `Authorization: Bearer <CRON_SECRET>`, which is what such handlers check.
- The function is called with `{ scheduledTime, rule }` and no `context.auth`;
  token verification on the API domain does not apply to it. A run that ends
  in a 5xx is thrown, so Lambda records it and, as for any asynchronous
  invocation, retries it up to twice (set the function's maximum retry
  attempts to 0 for at most one run); so is a 4xx result, which means a guard that refuses the run. Scheduled runs do not happen under `listen()`.
- Changing an expression or the function's name replaces the rule. The
  provider profile names the deployer type (`schedule.type` in
  `src/providers.ts`), so another provider's scheduler (Cloud Scheduler on GCP)
  is a new deployer, not yet implemented.

### Events: `@cloudgear/events`

A function can also run when an event is published on a bus, as an alternative
to a schedule (the two MAY be combined):

```ts
import { FunctionRouter } from "@cloudgear/functions";
import { EventBus, on } from "@cloudgear/events";

const orders = new EventBus("aws", { name: "orders" }); // omit the name for the account's default bus

export async function charge({ id }: { id: string }) {
  await orders.publish("order.created", { id });       // source defaults to "cloudgear"
  return { id };
}

export class Mail {
  @on(orders.event({ type: "order.created", source: "cloudgear" }))
  static async receipt(order: { id: string }, context: { event?: { id: string; type: string; source: string } }) { /* ... */ }
}

new FunctionRouter("aws")
  .url("POST", "/charge", charge)
  .url("POST", "/refund", refund, { on: orders.event("order.refunded") });
```

- `bus.event("type")` or `bus.event({ type, source })` is the trigger. It goes in
  a route's `on` option (one, or an array) or in `@on(...)` on a class method,
  like `schedule` and `@schedule`. `@on` makes a function with no route and no
  function URL. Everything MUST be a literal, and the bus MUST be assigned to a
  variable, since `generate` reads it without running your code.
- On AWS a named bus is created as `<project>-<name>` and removed again by
  `destroy`; the default bus is never created or deleted. Each trigger becomes
  an EventBridge rule (`@aws.EventRule`) matching `detail-type` (and `source`,
  when given) that targets the function, plus a Lambda permission for
  `events.amazonaws.com`.
- The function receives the event's `detail` as its input (an object; any other
  JSON value arrives as `{ detail }`) and the event's `id`, `type`, `source` and
  `time` as `context.event`. A run that ends in a 5xx is thrown, so Lambda
  retries it as for any asynchronous invocation; a 4xx answer is logged and not
  retried, since the same event would fail again.
- `bus.publish(type, detail, { source })` returns the event id. A function that
  calls it is granted `events:PutEvents` on exactly that bus and finds the bus
  name in `CLOUDGEAR_EVENTBUS_<NAME>`. `publish` is traced through aliases of the
  bus variable; a bus passed to another function as a value is not, and
  `generate` warns. Declare each bus once and import it, and use bus names
  that stay different after `-`, `.` and `_` are treated alike. A function that
  handles a bus's events and publishes to it gets a warning, since publishing
  the type it handles loops. A detail is limited to about 250 KB.
- Publishers MUST NOT use a `source` starting with `aws.`. Matching is on type
  and source only for now; a `detail` pattern is not supported. Events are
  delivered at least once, so handlers SHOULD be idempotent. Only `aws` is
  supported; set `CLOUDGEAR_EVENTS_DRIVER=memory` to record published events
  in tests (`memoryEvents()` from `@cloudgear/events/drivers/memory`).

### Provider options

Settings that have no dedicated option go in `options`, a map of string,
number or boolean literals (written as strings) that `generate` reads and stores
in the config as a proto `map<string, string>` on `Resource`, `Function`,
`Certificate`, `Cdn` and `Api`. They are part of each entry's compared `spec`, so
changing one updates the entry. Unknown keys and invalid values fail
`generate` and `plan`, listing the supported keys.

```ts
new BlobStore("aws", "://data", { options: { versioning: true } });
new FunctionRouter("aws", { functionOptions: { tracing: "Active", "env.STAGE": "prod" } })
  .url("GET", "/report", report, { options: { ephemeral_storage_mb: 2048 } });
new Cert("aws", dns, { options: { key_algorithm: "EC_prime256v1" } });
new CDN("aws", cert, { bucket, options: { price_class: "PriceClass_100" } });
```

| Type | Keys |
| --- | --- |
| `@aws.S3` | `versioning` (`true`, `false`) |
| `@aws.Lambda` | `tracing` (`Active`, `PassThrough`), `ephemeral_storage_mb` (512 to 10240), `env.<NAME>` |
| `@aws.CloudFront` | `price_class` (`PriceClass_100`, `PriceClass_200`, `PriceClass_All`), `default_root_object`, `web_acl` (a WAFv2 web ACL ARN in `us-east-1`) |
| `@aws.Certificate` | `key_algorithm` (`RSA_2048`, `EC_prime256v1`, `EC_secp384r1`) |

A function's options are the router's `functionOptions` overridden by its
routes' `options`; the routes of one function MUST give it identical options (or none). `tracing: "Active"` also lets the role write X-Ray segments. `env.<NAME>`
MUST be a plain identifier (letters, digits and `_`, starting with a letter), MUST NOT start with `AWS_`,
`CLOUDGEAR_` or `LAMBDA_`, and cannot be `NODE_OPTIONS`.
Declaring a store twice with different options fails. An existing certificate
cannot change `key_algorithm`. Add a key by extending `options` in
`src/providers.ts` and handling it in the driver.

## Hybrid clouds

Each entry in the config names its own provider through its `type`
(`@aws.S3`, `@gcp.GCS`, `@gcp.CloudFunction`). The top-level `provider` is the
router's provider, and every function runs there. A `BlobStore` MAY use any
provider, so an app can have functions on GCP, a bucket on AWS and another on
GCS:

```ts
const archive = new BlobStore("aws", "://archive");
const cache = new BlobStore("gcp", "gs://cache");
new FunctionRouter("gcp").url("GET", "/report/{id}", getReport);
```

```
provider: "gcp"
resource { name: "archive"  type: "@aws.S3"  physical_name: "archive" ... }
resource { name: "cache"    type: "@gcp.GCS" physical_name: "cache" ... }
function {
  name: "getReport"
  type: "@gcp.CloudFunction"   runtime: "nodejs22"  timeout_s: 60
  permission { resource: "archive"  action: "s3:GetObject"  action: "s3:ListBucket" }
  permission { resource: "cache"    action: "storage.objects.get" }
  env { key: "CLOUDGEAR_BLOB_ARCHIVE"  value_from: "archive" }
  env { key: "CLOUDGEAR_BLOB_CACHE"    value_from: "cache" }
  ...
}
```

A function's permissions are written in the vocabulary of the store's provider
(IAM actions for S3, `storage.objects.*` permissions for GCS). On GCP a function
runs as a service account, which its deployer creates and grants on the
function's own buckets, as AWS creates a role for a Lambda. `provider` profiles
in `src/providers.ts` hold each provider's types, defaults, permission
mapping, option keys and reserved environment names.

What exists today: the config, `generate` (a Cloud Functions HTTP adapter
bundles the functions) and `plan` handle several providers. There are no GCP
deployers, so `apply` stops before doing anything if the config uses a provider
without deployers, and a CDN, an API domain or a schedule needs a provider that
supports it (AWS). Access from a function to a store of another provider is not
provisioned yet: `generate` warns, and the function gets no credentials for the
store. A mechanism (a stored key, workload identity federation, a signed URL)
registers under `"<function provider>-><store provider>"` in
`CROSS_PROVIDER_ACCESS`, and a deployer per provider is added to `DEPLOYERS` in
`src/cli.ts`. `apply` and `destroy` use the deployers of the providers in the
planned actions, so removing the last GCP entry lets `destroy` run with AWS
alone. The GCP adapter never trusts a caller identity sent in the request,
because nothing authenticates callers before it runs; the router's API domain
needs provider `aws`.

## `@cloudgear/core`

One import for the decorators and helpers an app uses: `policy`, `permissions`,
`grant`, `schedule`, `cron`, `jwtAuth` and `response` (re-exported unchanged
from `@cloudgear/blob` and `@cloudgear/functions`, which the analyzer follows
through the re-export), plus `guard`:

```ts
import { claim, guard, permissions, policy } from "@cloudgear/core";

export class Reports {
  @guard(claim("role", "admin"))
  @policy(reports, { permissions: [permissions.Get] })
  static async read({ id }: { id: string }) { /* ... */ }
}
```

`@guard(...checks)` runs the method only when every check passes, otherwise it
answers `401` (no caller) or `403` (a caller the checks refuse) without calling
it. A check is `(input, context) => boolean | Promise<boolean>` and sees
`context.auth`, which comes from the router's `authenticate`, `jwtAuth` or a
trusted router call, so a guard is only as good as the authentication behind
it. Built in: `authenticated()`, `claim(name, value | predicate?)`, `allOf`,
`anyOf` and `not`. Checks are evaluated in order and stop at the first refusal;
a check that throws is a 500, never a refusal. Stores a check uses count as the
function's own uses, like any other code in it. A guard works on methods like
`@policy` and `@schedule` do (static, or instance through an exported
instance), and wraps the method, so the order of decorators does not matter.
The wrapper is async (a sync method then returns a promise, which the router
awaits) and keeps the method's name. The input is the first argument and the
context the last, so it also works with the `response` option; with `request`
the first argument, and so the checks' input, is the request. Several contexts
carry no caller, so a guarded route there always answers 401: `public: true`
routes, `authenticated: "none"`, a router served through a CDN or API domain
without `jwtAuth`, GCP, and scheduled runs (a scheduled run that a guard
refuses fails, so do not guard a scheduled method).

## Secrets: `@cloudgear/secrets`

A function declares the secrets it reads, so IAM can grant exactly those and
nothing else:

```ts
import { FunctionRouter } from "@cloudgear/functions";
import { SecretStore } from "@cloudgear/secrets";

const store = new SecretStore("aws"); // SSM SecureString; { service: "secretsmanager" } is the alternative
const app = store.path("/cloudgear/myproject");

new FunctionRouter("aws")
  .url("POST", "/charge", "./charge.ts", { env: app(["STRIPE_KEY", "DB_URL"]) }) // process.env.STRIPE_KEY
  .url("POST", "/refund", "./refund.ts", { env: app({ API_KEY: "stripe-key" }) }); // API_KEY from secret "stripe-key"
```

`env:` takes `app([...names])` or `app({ ENVVAR: "secret-name" })`, on a route
or on the router. It MUST be literal: the analyzer never runs your code, so a
computed name is an error. At cold start the Lambda adapter reads the declared
secrets into `process.env` (a variable already set is never overwritten); a
failure answers `500` and is retried on the next request. The role gets
`ssm:GetParameter(s)` (or `secretsmanager:GetSecretValue`) on those exact
parameters only. `kms:Decrypt` is granted only for an explicit `kmsKey` (a key
id or ARN, never an alias).

A path ending in `/*` (`store.path("/cloudgear/myproject/*")`, passed as
`env: everything`) grants every secret under it, and so every secret added
later. It is allowed and SHOULD be avoided. The SSM grant is a prefix, so it
also matches deeper paths; cloudgear never writes secret names containing "/".

Secrets are read once per cold start, so a rotated value reaches a warm
function only after it restarts. They are in `process.env` before your handler
runs but after your module's top level has loaded, so read them inside
functions, not at import time.

Code that reads a secret itself calls `app("NAME").get()`: the environment
variable of that name first, then the store. Such a binding has no `env` and
only grants IAM.

Infrastructure setup uses the same references. `cloudgear apply` reads
`app("GANDI_TOKEN")` with the deployer's own credentials, the environment
variable of that name taking precedence; the value is never written to the
config, state or logs:

```ts
const dns = new DNS("gandi", "api.example.com", { zone: "example.com", token: app("GANDI_TOKEN") });
```

```sh
cloudgear secrets set --from-envfile .env.prod   # stores the declared names only
cloudgear secrets set STRIPE_KEY                 # value on stdin
cloudgear secrets list                           # ok / missing / unused, never values
```

`--from-envfile` refuses a file that git tracks, and one that git does not
ignore (`--allow-unignored` overrides the latter); `.env*` and `*.env` are in
this repository's `.gitignore`. A renamed binding (`{ API_KEY: "stripe-key" }`) is looked up in the file by
either name. Names in the file that nothing declares are
skipped with a warning (`--all` stores them under the only declared path, or
`--path`). SSM values are limited to 4096 characters, Secrets Manager's to
65536. Only the `aws` provider is supported; GCP is not implemented yet.

## Debugging

Set `CG_DEBUG=true` (also `1`, `yes`, `on`) to print debug lines on stderr,
each tagged `[cg:debug HH:MM:SS.mmm] scope: message {data}`; stdout is
unchanged and nothing is printed when it is unset. The variable is read on
every call, so it works for the CLI, a local app and a deployed function alike.

| Scope | What it logs |
| --- | --- |
| `cli` | the command, config and state paths, the drivers selected through `CLOUDGEAR_*`, region resolution, the plan summary, and a stack trace when a command fails |
| `generate` | the analysis (provider, resources, functions with routes, schedules and accesses, certificates, CDN, API), each bundle's size and sha256, the written config |
| `apply`, `state` | every action with its duration and result, and each state save with the output names |
| `aws.<service>` | every SDK call (`CreateBucketCommand`, `PutRuleCommand`, ...) with its duration and outcome |
| `dns`, `gandi`, `route53` | record operations (provider, zone, name, values) and Gandi's status codes |
| `blob`, `cert`, `cdn` | store operations (key and size), certificate and CDN status lookups |
| `router`, `lambda` | route matching, authentication outcome, rate limiting, remote calls (host, signed or not, status) and the Lambda adapter's request, verification and response |

Values under keys that can hold secrets or large payloads are replaced with
`[redacted]`: authorization and cookie headers, tokens, credentials, signatures,
sessions, passwords, Lambda environment variables, code, IAM and bucket
policies, request bodies, generic `Value`/`Input`/`Payload` fields and caller
claims; long strings, arrays and nested objects are shortened. What is still
logged, so do not put secrets there: blob object keys, bucket names, URLs,
ARNs, DNS record names and values (public data), the concrete path of a request
that matched no route, and error messages up to 300 characters (parse errors
are reduced to `SyntaxError: invalid input`). A matched request is logged by
its route template, so path parameters stay out. To debug a deployed function,
give it the variable (`functionOptions: { "env.CG_DEBUG": "true" }`) and read
its CloudWatch logs; adding the debug package changes every function's bundle,
so the first `apply` after upgrading redeploys all functions.

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

Alternatively declare a function's permissions with `@policy`, a method
decorator. TypeScript decorates class members, so the routed function is a
method of a class, either `static` on an exported class or an instance method
reached through an exported instance (`export const api = new Api(...)`, routed
as `api.read`; the receiver MUST be that exported variable itself, not an alias
or property, and the instance MAY live in another module; with several
instances of one class, each routed method belongs to one):

```ts
import { BlobStore, permissions, policy } from "@cloudgear/blob";

export class Local {
  @policy(bucket, { permissions: [permissions.Get, permissions.Put, permissions.List] })
  static async getObjects({ param }: { param: string }) { /* ... */ }
}
router.url("GET", "/objects/{param}", Local.getObjects);
```

The policy is the guard: those are exactly the function's permissions on that
store (even if unused), and `generate` fails if the function's code needs more
(for example calls `put` without `permissions.Put`), or passes the store to a
helper, which it cannot follow (declare `grant(store, ...)` inside to say what
the helper does). `permissions` are
`Get`, `Put`, `Delete` and `List` (`exists` needs `Get` and `List`); the store
and the list MUST be literal. It is a no-op at runtime.

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
  (including the options' `path`); it MAY use any provider (see Hybrid clouds).

Directives go in a comment on the declaration line or the line above it:

- `// cloudgear: dry`: the resource already exists; cloudgear never creates,
  updates or deletes it. Its physical name is the URI name.

Each function is bundled with `Bun.build` into
`.cloudgear/build/<name>/index.mjs`: the function's module, its whole import
tree and the `node_modules` it reaches, wrapped in the router's provider's
handler adapter (Lambda for `aws`, a Cloud Functions HTTP function for `gcp`).
Bundles target Node.js.

The output is `cloudgear.prototxt`, protobuf text format for the
`cloudgear.Config` message in `src/config/cloudgear.proto`. This is
`examples/router-app`, cut down to one resource and one function:

```
# proto-file: cloudgear.proto
# proto-message: cloudgear.Config
# Generated by `cloudgear generate`. Do not edit by hand.

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
  source {
    file: "server/api.ts"
    export: "foo"
    input_type: "types.FooInput"
  }
  route {
    method: "POST"
    path: "/foo/{param}"
    name: "createFoo"
  }
  bundle {
    path: ".cloudgear/build/foo/index.mjs"
    sha256: "..."
  }
  permission {
    resource: "myblob"
    path: ""
    action: "s3:PutObject"
  }
  env {
    key: "CLOUDGEAR_BLOB_MYBLOB"
    value_from: "myblob"
  }
  reserved_concurrency: 0
}
authenticated: "iam"
```

### Environment variables the code reads

`cloudgear generate` also lists what each function's code reads from the
environment (`process.env.X`, `process.env["X"]`, `Bun.env.X`, `import.meta.env.X`
and destructuring) in `cloudgear.env.json`, next to the config, by function name:

```json
{
  "version": 1,
  "functions": {
    "api-items": {
      "routes": ["GET /api/items"],
      "variables": {
        "ITEMS_CURSOR_SECRET": { "required": true, "files": ["api/items.ts"], "provided": "secret" },
        "DB_URL": { "required": true, "files": ["lib/db.ts"], "provided": null }
      },
      "dynamic": []
    }
  }
}
```

- The scan follows the code the function runs: its body, what that calls
  (including helpers in other project files), and the top-level code of every
  project file it imports, which runs when the function loads. Other functions
  that merely share its file are not included. `node_modules`, `require()` and
  dynamic `import()` are not followed. `process.env`, `Bun.env`,
  `globalThis.process.env`, `import.meta.env`, casts, and one-step aliases
  (`const env = process.env`) are understood.
- A variable is `required` unless every read has a fallback (`?? x`, `|| x`,
  `??=`), is compared (`=== "production"`, `!== undefined`), is a presence check
  (`if (process.env.X)`, `Boolean(...)`, `typeof`, `?.`) or has a destructuring
  default. A check that throws or exits (`if (!process.env.X) throw ...`) makes it
  required. Assigning or deleting a variable is not a read. `provided` says how it reaches the function: `resource`
  (set by cloudgear), `option` (`functionOptions: { "env.X": "..." }`), `secret`
  (an `env` binding), `secret-wildcard` (a `/*` path may hold it), `platform`
  (`AWS_*`, `LAMBDA_*`, `TZ`, `NODE_ENV`, `CI` and the like) or `null`.
- A variable the code tolerates being unset in a way the scan cannot see (for
  example one passed to a library that accepts `undefined`) is listed in the
  router's `optionalEnv: ["SENTRY_DSN"]` (string literals), so it is no longer
  required. A conversion before a fallback (`Number(process.env.X) || 0`) is
  already optional.
- A computed read (`process.env[name]`) or a spread is listed under `dynamic`
  and warned about; those variables cannot be checked.
- `cloudgear apply` reads the report and refuses to deploy while a required
  variable has `provided: null`, and while a declared secret is not stored (see
  `cloudgear secrets list`). `cloudgear plan` only warns. Pass
  `--skip-env-check` to deploy anyway. Checking that secrets are stored needs
  list access to the store (`ssm:GetParametersByPath` for SSM,
  `secretsmanager:ListSecrets` for Secrets Manager, and `kms:Decrypt` for a
  named key); without it `apply` explains and suggests the flag. The report
  records the hash of the config it was made for, so commit both together; if
  they differ, `apply` asks for `generate` again. If the report is missing, `apply` asks
  for `generate` first. The report holds names and file paths, never values, so
  it MAY be committed.

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
function URL with `AuthType: AWS_IAM`. Credentials come from the standard AWS
SDK chain.

#### Tags

Every AWS resource `apply` creates (bucket, IAM role, function, schedule rule,
certificate, distribution, API and API domain) is tagged:

| Tag | Value |
| --- | --- |
| `cloudgear:managed-by` | `cloudgear` |
| `cloudgear:version` | the cloudgear version that created it |
| `cloudgear:project` | the config's project |
| `cloudgear:env` | `--env`, when given (for example `prod`) |
| `cloudgear:author` | `--author`, else `git config user.name`, else `$USER` |
| `cloudgear:resource` | the resource's logical name |

`--tag key=value` (repeatable) adds more; `cloudgear:` and `aws:` keys are
reserved. Values are sanitized to what AWS accepts. Tags are set when cloudgear
creates a resource: resources that already exist are not retagged, and a tag
change alone is not a planned change. Remove the resource or tag it yourself to
update it. A distribution's origin access control and edge function cannot be
tagged.

Tags need extra IAM permissions for the deploying principal: `s3:PutBucketTagging`,
`iam:TagRole`, `lambda:TagResource`, `events:TagResource`,
`acm:AddTagsToCertificate`, `cloudfront:TagResource`, and `apigateway:POST` on
`/tags/*`. A missing one fails the create (a bucket whose tagging fails is
deleted again). `cloudgear:author` holds a person's name, readable by anyone
who can list tags, and appears in billing exports; pass `--author ci` to
avoid that. A tag key is up to 128 characters of letters, digits, spaces and
`+ - = . _ : / @`, and a resource takes at most 50 tags.

`cloudgear:managed-by` is also how the AWS Lambda MCP server finds the
functions: `.mcp.json` runs `awslabs.lambda-tool-mcp-server` with
`FUNCTION_TAG_KEY=cloudgear:managed-by` and `FUNCTION_TAG_VALUE=cloudgear`, so
only cloudgear's functions become tools. It uses the AWS credentials and
`AWS_REGION` of the environment it starts in.

#### Regions

The deploy region is the router's `region` option, else `--region`, else
`$AWS_REGION` or `$AWS_DEFAULT_REGION`. A `BlobStore` can pass its own
`region` (`new BlobStore("aws", "://data", { region: "eu-west-1" })`) to live
elsewhere; the CDN then reads it from that region. Both options MUST be string
literals, since `cloudgear generate` reads them. A bucket cannot move between
regions: changing `region` on an existing bucket fails the apply.

## Policies: `@cloudgear/iam`

`cloudgear` writes one inline policy on each function's role, from the permissions
it infers (blob stores, secrets, event buses). Anything else the function may do is
declared with a `Policy`, from a JSON file or an object literal:

```ts
import { FunctionRouter } from "@cloudgear/functions";
import { Policy } from "@cloudgear/iam";
import readBucket from "./policies/read-bucket.json";   // an exported policy, see `cloudgear import --write-policies`

const reader = new Policy("aws", { name: "read-bucket", document: readBucket });
const queue = new Policy("aws", {
  name: "send-queue",
  document: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "sqs:SendMessage", Resource: "arn:aws:sqs:us-east-1:111122223333:jobs" }] },
});

new FunctionRouter("aws", { policies: queue }).url("GET", "/items", items, { policies: [reader] });
```

- `policies` takes one `Policy` or an array, on a route or on the router (for every
  function). A `Policy` MUST be assigned to a variable. Its `name` and `document`
  MUST be literals: an object literal, or the default import of a relative `.json`
  file. `generate` reads the file; nothing is run. Names are 1 to 128 of
  `A-Za-z0-9_+=,.@-`, unique, and MUST NOT start with `cloudgear`; a document needs
  `Version`, and `Statement` entries with `Effect`, an action and a resource, in at
  most 10,240 characters.
- On AWS each is put on the function's role as an inline policy under its own name,
  next to the one cloudgear infers, so the function gets the union. A changed
  document is a `permissions` update in `plan`; a policy taken out of the code is
  removed from the role; `destroy` removes them, even from a role cloudgear leaves in
  place (an imported function's). A function's role has to stay within IAM's 10,240
  characters of inline policy in all.
- `generate` warns about an `Allow` statement with `"Action": "*"` or
  `"Resource": "*"`: that is the line to read twice in a review.
- Rules checked before `apply`: `Version` is `"2012-10-17"` (the old version
  turns policy variables off), no `Principal`, a unique string `Sid`, a non-empty
  `Action` and `Resource`, and a `Condition` that is an object. The declared
  policies and the inferred one together MUST stay under IAM's 10,240 characters
  for the role; `apply` refuses before it puts any of them when they do not. On
  an imported role that is shared by several functions, a policy name that more
  than one of them declares stays on the role until the last of them drops it,
  and the role may carry other policies that count towards that limit.
- Only inline policies, for now: a customer-managed policy is not a `Policy`.
  Naming a policy after one the role already has (for example after
  `cloudgear import --write-policies`) makes cloudgear take that policy over: the next `apply`
  overwrites it with the document in your repository.

## `cloudgear import`

`cloudgear import` adopts things that already exist in the cloud into state, so
`apply` does not try to create them again:

```sh
cloudgear import web.example.com                   # a bucket from the config's resources
cloudgear import api-items                         # a function, by name
cloudgear import @aws.Certificate www.example.com  # when several things share a name
cloudgear import --all                             # everything planned that already exists
```

- The ARN says what kind of thing it is, so the type is not needed:
  `cloudgear import --arn arn:aws:acm:...` finds the certificate it describes and
  adopts the config entry for its domain (a distribution, by the domains it
  answers to; a function or rule, by name; a bucket, by its physical name, else its
  config name). With a name, the
  ARN picks the right one of several that share it: `cloudgear import
  www.example.com --arn arn:aws:acm:...` is the certificate, not the
  distribution. A type that disagrees with the ARN is an error. If no entry fits,
  each reason is listed and nothing is recorded; when the ARN fits several
  entries (a distribution with two aliases that both have a CDN entry), none is
  recorded and you are asked to say which. An object ARN is not a bucket ARN. A
  bucket is recorded without a lookup in the cloud, as before.
- `--arn <arn>` says exactly which one to adopt when the name is not enough, for
  example two certificates for a domain: `cloudgear import @aws.Certificate
  www.example.com --arn arn:aws:acm:us-east-1:...:certificate/...`. Accepted
  ARNs (any partition: `aws`, `aws-cn`, `aws-us-gov`): an ACM certificate (its domain must be the config's, it must be in the
  certificate's region, and issued or waiting for validation), a CloudFront
  distribution (it must answer to the config's domain), a Lambda function (the
  function's own ARN, not a version or alias, in the functions' region) and an
  EventBridge rule on the default bus (their names must be the ones the config
  deploys), and an S3
  bucket (`arn:aws:s3:::name`, also as the second argument:
  `cloudgear import web.example.com arn:aws:s3:::web.example.com`). Without
  `--all`, one thing at a time.
- A bucket is only recorded (optionally under another physical name:
  `cloudgear import myblob my-existing-bucket`). Imported buckets are never
  created, changed or deleted (`destroy` only forgets them), and functions that
  use them get that physical name in their env and IAM policy. A name that is
  also a bucket's takes the bucket; use `<type> <name>` for the others.
- Functions (found by their name), ACM certificates (by domain, in the
  certificate's region; an issued one wins over a pending one), CloudFront
  distributions (by alias hostname) and schedule rules (by name) are looked up
  in AWS and their ARNs, role, URL and ids recorded. They are managed from then
  on: the next `cloudgear plan` shows them as updates, and `apply` brings them in
  line with the config without creating them again. `destroy` deletes them,
  except a function's IAM role when cloudgear did not create it (an imported
  function may use a shared one); the inline policy cloudgear adds to that
  role is removed.
- An existing distribution's web ACL (the `CreatedByCloudFront-...` one the console
  adds, or your own) is kept by naming it in the CDN's options: `new CDN("aws", cert,
  { bucket, options: { web_acl: "arn:aws:wafv2:us-east-1:<account>:global/webacl/<name>/<id>" } })`.
  The ARN MUST be a WAFv2 web ACL in `us-east-1` (the `aws` partition only). The
  option works for a new distribution as well as an imported one, and in the
  options of the CDN that serves the router. `import` prints the exact option for
  the ACL it finds (not for a WAF Classic ACL, whose id is not an ARN and cannot
  be kept). Without the option `apply` detaches the ACL, and removing the option
  detaches it too. cloudgear does not create or change web ACLs; the ACL MUST be in
  the account the distribution is in, and associating it may need
  `wafv2:GetWebACL` and `wafv2:AssociateWebACL` (and `wafv2:DisassociateWebACL` to
  detach) next to the CloudFront permissions; an ACL the credentials cannot use
  fails `apply` with AWS's error.
- **Read the warnings.** `apply` rebuilds an imported distribution's config from
  yours, so `import` lists what it would drop: a web ACL, access logging,
  custom error responses, a geo restriction, path behaviors and origins that are
  not in the config, a non-default price class. An imported function's code is
  replaced by the bundle, its handler becomes `index.handler`, and its
  environment variables that are not in the config are removed. `import` only
  warns; look at `cloudgear plan` and your console before `apply`. A Route 53
  alias record for the hostname is not seen by the DNS check (only CNAMEs are).
  Tags are not added to imported things until they are recreated, and a
  container-image function cannot be imported.
- An imported certificate that is already issued needs nothing: `apply` reads its
  status and leaves it alone, without touching DNS. One still waiting for
  validation is validated as before (the CNAME is written and polled).
- The certificate search covers every key type and takes the issued one that
  expires last; an IMPORTED certificate is used as it is, without waiting for DNS
  validation. Reserved concurrency and the URL's auth type are read from the
  function, so the plan changes only what differs.
- Functions imported with a role of their own keep a policy named
  `cloudgear-<function>` on it, so several functions on one role do not
  overwrite each other, and `destroy` removes only that policy and not the role.
- `import --all` records everything it finds even when one lookup fails, then
  lists the failures and exits 1. `destroy` before the first `apply` deletes an
  imported distribution without removing its DNS record or bucket-policy
  statement, which `apply` records; run `apply` first.
- With `--write-policies <dir>` an imported bucket's policy goes to
  `<dir>/buckets/<bucket>/policy.json` (a bucket without one is noted; a policy the
  credentials cannot read is a warning, not a failure; it needs `s3:GetBucketPolicy`).
  cloudgear adds only its own statement for a CDN to that policy; the rest is left as it is.
- `--write-policies <dir>` also writes the IAM policies of an imported function's
  role as JSON files, so what the function may do is in the repository and in
  review: `<dir>/<role>/inline-<policy>.json` for each inline policy,
  `<dir>/<role>/managed-<policy>.json` for each customer-managed policy attached,
  and `<dir>/<role>/index.json` listing both and the AWS-managed policies
  attached by ARN. The policies cloudgear itself writes (`cloudgear`,
  `cloudgear-<function>`, on the role cloudgear made) are skipped. A role's
  permissions boundary and trust policy are not exported, so the files can
  show more than the function may do. Export can be run again for a function
  that is already imported; files are checked together before any is written,
  and each says whether it was written, overwritten or unchanged (the directory
  is not cleaned of policies since removed from the role). If IAM refuses a read,
  the function is still imported and a warning says why. It only reads: cloudgear does not manage
  these policies, and the function keeps them. It needs `iam:ListRolePolicies`,
  `iam:GetRolePolicy`, `iam:ListAttachedRolePolicies`, `iam:GetPolicy` and
  `iam:GetPolicyVersion`. Files are written only under `<dir>`, and policies can
  name resources and accounts, so review them before committing.
- With `--all`, whatever is not found is left for `apply` to create. A thing
  that has no import yet (API Gateway domains, event buses and rules) is skipped.
- Import changes only the state file. It needs read access to the service it
  looks in (`lambda:GetFunction`, `acm:ListCertificates`,
  `cloudfront:ListDistributions`, `events:DescribeRule`, `s3:ListBucket`), and
  your credentials, like `apply`.
- A function that had its own role keeps it, and `apply` adds the inline policy
  cloudgear manages to that role; check the role's other policies first.

## Packages

The workspace packages under `packages/` are imported by apps and bundled into
deployed functions. They are private and not published yet.

| Package | Purpose |
| --- | --- |
| `@cloudgear/functions` | `FunctionRouter`, `jwtAuth`, `cron`, `schedule`, `response`, the Lambda and Cloud Functions adapters |
| `@cloudgear/blob` | `BlobStore`, `policy`, `permissions`, `grant` |
| `@cloudgear/cdn` | `Cert` and `CDN` |
| `@cloudgear/dns` | `DNS` and its Gandi and Route 53 drivers |
| `@cloudgear/events` | `EventBus` and `on` |
| `@cloudgear/secrets` | `SecretStore` |
| `@cloudgear/core` | One import for the decorators and helpers, plus `guard` |
| `@cloudgear/debug` | `CG_DEBUG` logging |

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
| GCP function adapter | `packages/functions/drivers/gcp.ts` | bundles (`src/build/bundle.ts`) |
| `DNS` | `packages/dns/index.ts` | apps; `src/analyze/app.ts` |
| `registerDnsDriver`, `createDnsDriver` | `packages/dns/driver.ts` | `DNS`; `src/cli.ts`; custom drivers |
| Gandi, Route 53 and memory DNS drivers | `packages/dns/drivers/` | `createDnsDriver` |
| `Cert`, `CDN` | `packages/cdn/index.ts` | apps; `src/analyze/app.ts` |
| Cert drivers (`acm`, `memory`) | `packages/cdn/cert-driver.ts`, `packages/cdn/drivers/` | `Cert.status()` |
| CDN drivers (`cloudfront`, `memory-cdn`) | `packages/cdn/cdn-driver.ts`, `packages/cdn/drivers/` | `CDN.status()`, `CDN.url()` |
| `policy`, `permissions` | `packages/blob/index.ts` | apps; `src/analyze/app.ts` |
| certificate, CloudFront and API Gateway drivers | `src/deploy/aws/certificate.ts`, `cloudfront.ts`, `apigateway.ts` | `awsDrivers` |
| schedule driver (EventBridge) | `src/deploy/aws/schedule.ts` | `awsDrivers` |
| `cron`, `schedule` | `packages/functions/cron.ts` | apps; `src/analyze/app.ts`, `src/deploy/plan.ts` |
| `guard`, checks, re-exports | `packages/core/index.ts` | apps |
| `groupRoutes`, `conflictingGroups` (CloudFront paths) | `src/routes.ts` | `src/analyze/app.ts`, `src/deploy/plan.ts` |
| `routeFunctionCode` (method routing) | `src/deploy/aws/route-function.ts` | `src/deploy/aws/cloudfront.ts` |
| `debug`, `timed`, `redact` | `packages/debug/index.ts` | every package and `src/` |
| `encodeConfig` / `decodeConfig`, prototxt codec | `src/config/` | `generate`, `plan`, `apply` |
| `plan`, `apply`, `endpointsFrom` | `src/deploy/` | `src/cli.ts` |
| `awsDrivers` | `src/deploy/aws/index.ts` | `src/cli.ts` |
| `EventBus`, `on` | `packages/events/index.ts` | apps; `src/analyze/app.ts` |
| event driver (`eventbridge`, `memory`), `memoryEvents` | `packages/events/driver.ts`, `packages/events/drivers/` | `EventBus.publish` |
| EventBridge bus and rule deployers | `src/deploy/aws/eventbus.ts`, `schedule.ts` | `awsDrivers` |
| `SecretStore` | `packages/secrets/index.ts` | apps; `src/analyze/app.ts` |
| `cloudgear secrets` (`setSecrets`, `secretStatus`), env file parsing | `src/secrets/` | `src/cli.ts` |
| environment report, `checkEnvironment` | `src/analyze/envuse.ts`, `src/envreport.ts`, `src/envcheck.ts` | `generate`, `plan`, `apply` |
| `adoptEntries`, `adoptByArn` | `src/deploy/adopt.ts` | `cloudgear import` |
| resource tags (`baseTags`) | `src/deploy/aws/tags.ts` | `src/cli.ts`, the AWS deployers |

## Status

Early draft. Only the `aws` provider has deploy drivers (`gcp` is described and planned, see Hybrid clouds);
`BlobStore` is the only storage client. Function URLs are IAM-protected, so
the router needs AWS credentials (see Authentication). Input objects are not
validated against their TypeScript types at runtime. An app has any number of
CDNs for static sites but at most one that serves the router, and uploading the
static site is not built yet.

## Testing

```sh
bun test                    # the full suite (about 5 minutes)
bun test tests/tags.test.ts # one file
bun run typecheck           # tsc --noEmit
```

Tests run against fakes and in-memory drivers; they need no AWS credentials.
On a pull request, CI runs only the tests affected by the changed files (see
`scripts/changed-tests.ts`), and a nightly run covers the full suite.

## Linting

```sh
bun run lint               # biome lint .
```

[Biome](https://biomejs.dev) runs its recommended rules, configured in
`biome.json`; formatting is not checked.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Participation is covered by the
[Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities as described in
[SECURITY.md](SECURITY.md).

## Licence

[MIT](LICENSE).
