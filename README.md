# cloudgear

Parses a small TypeScript infra-shorthand file via AST (never executes it)
and generates an AWS CDK stack from a convention-based plugin per resource
type. Plugins are only imported for the resource types actually present in
the source file, resolved dynamically at generation time.

## Usage

```sh
bun install
bun factory.ts <source-file.ts> [outDir]
```

See `examples/api-stack.ts` for the shorthand syntax. Running it against
that file writes `generated-stack.ts` (the CDK stack) and `resources.toml`
(a provisioning-status placeholder per resource) into `outDir` (default:
the current directory).

## Shorthand syntax

```ts
new aws.Lambda("handler", "./src/handler", "index.handler"); // handler arg optional, defaults to index.handler
new aws.DynamoTable("items"); // partition key optional, defaults to "id"
new aws.DynamoTable("sessions", "sessionId");
```

Every resource must be namespaced as `<provider>.<ResourceType>(name, ...)`.
Every argument after `name` must be a plain string literal -- this is a
fixed shorthand compiled into real CDK code by a plugin, not a general
parser for arbitrary CDK constructor calls (object-literal props, variables,
and nested expressions in argument position are rejected with an error
rather than silently mishandled).

## Adding a resource type

Add `plugins/<ResourceType>.ts`, default-exporting a function matching
`ResourceGenerator` from `types.ts`:

```ts
import type { CollectedResource, ResourceGenerator } from "../types";

const generateThing: ResourceGenerator = (res: CollectedResource) => {
  // res.arguments[i] is the (i+1)th constructor argument's string value,
  // or null if that argument wasn't a plain string literal.
  return `const ${res.name} = new somePackage.Thing(this, '${res.name}', { /* ... */ });`;
};

export default generateThing;
```

No registry to update -- the generator resolves `plugins/<ResourceType>.ts`
by the resource type parsed out of the source file.

## Status

Early draft, not yet used anywhere. AWS-only (the parsed `provider` segment
is captured but not yet dispatched on -- every plugin call currently
assumes AWS's CDK imports).
