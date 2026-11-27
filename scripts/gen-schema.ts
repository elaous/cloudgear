import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileRegistry, fromBinary, getOption, hasOption, type DescEnum, type DescMessage } from "@bufbuild/protobuf";
import { FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";

const ROOT = join(import.meta.dir, "..");
const GENERATED_HEADER = "// Generated from proto/ by scripts/gen-schema.ts; do not edit.\n";

// proto file -> generated file; several protos may share one.
const TARGETS: Record<string, string> = {
  "cloudgear/v1/blob.proto": "packages/blob/schema.gen.ts",
  "cloudgear/v1/cache.proto": "packages/cache/schema.gen.ts",
  "cloudgear/v1/network.proto": "packages/network/schema.gen.ts",
  "cloudgear/v1/dns.proto": "packages/dns/schema.gen.ts",
  "cloudgear/v1/cert.proto": "packages/cdn/schema.gen.ts",
  "cloudgear/v1/cdn.proto": "packages/cdn/schema.gen.ts",
  "cloudgear/v1/function_router.proto": "packages/functions/schema.gen.ts",
  "cloudgear/v1/secret.proto": "packages/secrets/schema.gen.ts",
};

const snake = (name: string): string => name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
const plural = (name: string): string => (/(S|X|Z|CH|SH)$/.test(name) ? `${name}ES` : name.endsWith("Y") ? `${name.slice(0, -1)}IES` : `${name}S`);
const literal = (value: unknown): string => JSON.stringify(value);

export function loadRegistry() {
  const dir = mkdtempSync(join(tmpdir(), "cloudgear-schema-"));
  try {
    const image = join(dir, "image.binpb");
    execFileSync("bunx", ["--bun", "buf", "build", "--exclude-source-info", "-o", image], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });
    return createFileRegistry(fromBinary(FileDescriptorSetSchema, readFileSync(image)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function generate(): Map<string, string> {
  const registry = loadRegistry();
  const extension = (name: string) => {
    const found = registry.getExtension(`cloudgear.v1.${name}`);
    if (!found) throw new Error(`extension cloudgear.v1.${name} is not in the schema`);
    return found;
  };
  const intent = registry.getEnum("cloudgear.v1.Intent");
  if (!intent) throw new Error("enum cloudgear.v1.Intent is not in the schema");
  const [valueName, defaultValue, operations] = [extension("name"), extension("default_value"), extension("operations")];

  const valueNameOf = (enumeration: DescEnum, number: number): string => {
    const value = enumeration.values.find((v) => v.number === number);
    if (!value) throw new Error(`${enumeration.name} has no value ${number}`);
    if (!hasOption(value, valueName)) throw new Error(`${value.name} has no (cloudgear.v1.name) option`);
    return getOption(value, valueName) as string;
  };
  const intentName = (number: number): string => {
    const value = intent.values.find((v) => v.number === number);
    if (!value || number === 0) throw new Error(`operation uses an unspecified or unknown intent (${number})`);
    return value.name.replace(/^INTENT_/, "").toLowerCase();
  };

  const enumNames = new Map<string, string[]>();
  const enumLines = (enumeration: DescEnum): string[] => {
    const [unspecified, ...rest] = enumeration.values;
    if (unspecified?.number !== 0 || !unspecified.name.endsWith("_UNSPECIFIED")) throw new Error(`${enumeration.name} must start with a *_UNSPECIFIED = 0 value`);
    const names = rest.map((v) => valueNameOf(enumeration, v.number));
    enumNames.set(enumeration.name, names);
    return [`export const ${plural(snake(enumeration.name))} = ${literal(names)} as const;`, ""];
  };

  // A nested message is named after its parents, such as FunctionRouterRoute.
  const labelOf = (message: DescMessage): string => message.typeName.replace(/^cloudgear\.v1\./, "").replaceAll(".", "");
  const messageLines = (message: DescMessage): string[] => {
    const lines: string[] = [`export const ${snake(labelOf(message))}_FIELDS = ${literal(message.fields.map((f) => f.name))} as const;`, ""];
    const ops = message.proto.options ? (getOption(message, operations) as { method: string; intents: number[] }[]) : [];
    if (ops.length) {
      lines.push(`export const ${snake(labelOf(message))}_OPERATIONS = {`);
      for (const op of ops) lines.push(`  ${op.method}: ${literal(op.intents.map(intentName))},`);
      lines.push("} as const;", "");
    }
    const defaults = message.fields.filter((f) => hasOption(f, defaultValue));
    if (defaults.length) {
      lines.push(`export const ${snake(labelOf(message))}_DEFAULTS = {`);
      for (const field of defaults) {
      const value = getOption(field, defaultValue) as string;
      const allowed = field.enum ? enumNames.get(field.enum.name) : undefined;
      if (allowed && !allowed.includes(value)) throw new Error(`${labelOf(message)}.${field.name} defaults to "${value}", not one of ${allowed.join(", ")}`);
      lines.push(`  ${field.localName}: ${literal(value)},`);
    }
      lines.push("} as const;", "");
    }
    return lines;
  };

  const bodies = new Map<string, string[]>();
  for (const [protoFile, target] of Object.entries(TARGETS)) {
    const file = registry.getFile(protoFile);
    if (!file) throw new Error(`${protoFile} is not in the schema`);
    if (file.messages.some((m) => m.nestedEnums.length)) throw new Error(`${protoFile}: nested enums are not supported; declare them at the top level`);
    const body = [...file.enums.flatMap(enumLines), ...file.messages.flatMap((m) => [m, ...m.nestedMessages]).flatMap(messageLines)];
    const merged = [...(bodies.get(target) ?? []), ...body];
    const names = merged.flatMap((line) => line.match(/^export const (\w+)/)?.[1] ?? []);
    const repeated = names.find((name, i) => names.indexOf(name) !== i);
    if (repeated) throw new Error(`${target}: ${repeated} is generated twice`);
    bodies.set(target, merged);
  }
  return new Map([...bodies].map(([target, body]) => [target, `${GENERATED_HEADER}\n${body.join("\n").trimEnd()}\n`]));
}

if (import.meta.main) {
  for (const [target, content] of generate()) writeFileSync(join(ROOT, target), content);
}
