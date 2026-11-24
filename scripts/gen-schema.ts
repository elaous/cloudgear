import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileRegistry, fromBinary, getOption, hasOption, type DescEnum, type DescMessage } from "@bufbuild/protobuf";
import { FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";

const ROOT = join(import.meta.dir, "..");
const GENERATED_HEADER = "// Generated from proto/ by scripts/gen-schema.ts; do not edit.\n";

// proto file -> package directory that receives the constants.
const TARGETS: Record<string, string> = {
  "cloudgear/v1/blob.proto": "packages/blob/schema.gen.ts",
  "cloudgear/v1/cache.proto": "packages/cache/schema.gen.ts",
};

const snake = (name: string): string => name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
const literal = (value: unknown): string => JSON.stringify(value);

export function generate(): Map<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "cloudgear-schema-"));
  try {
    const image = join(dir, "image.binpb");
    execFileSync(join(ROOT, "node_modules/.bin/buf"), ["build", "--exclude-source-info", "-o", image], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });
    const registry = createFileRegistry(fromBinary(FileDescriptorSetSchema, readFileSync(image)));
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
    const intentName = (number: number): string => intent.values.find((v) => v.number === number)!.name.replace(/^INTENT_/, "").toLowerCase();

    const enumLines = (enumeration: DescEnum): string[] => {
      const names = enumeration.values.filter((v) => v.number !== 0).map((v) => valueNameOf(enumeration, v.number));
      return [`export const ${snake(enumeration.name)}S = ${literal(names)} as const;`, ""];
    };

    const messageLines = (message: DescMessage): string[] => {
      const lines: string[] = [];
      const ops = message.proto.options ? (getOption(message, operations) as { method: string; intents: number[] }[]) : [];
      if (ops.length) {
        lines.push(`export const ${snake(message.name)}_OPERATIONS = {`);
        for (const op of ops) lines.push(`  ${op.method}: ${literal(op.intents.map(intentName))},`);
        lines.push("} as const;", "");
      }
      const defaults = message.fields.filter((f) => hasOption(f, defaultValue));
      if (defaults.length) {
        lines.push(`export const ${snake(message.name)}_DEFAULTS = {`);
        for (const field of defaults) lines.push(`  ${field.localName}: ${literal(getOption(field, defaultValue))},`);
        lines.push("} as const;", "");
      }
      return lines;
    };

    const out = new Map<string, string>();
    for (const [protoFile, target] of Object.entries(TARGETS)) {
      const file = registry.getFile(protoFile);
      if (!file) throw new Error(`${protoFile} is not in the schema`);
      const body = [...file.enums.flatMap(enumLines), ...file.messages.flatMap(messageLines)];
      out.set(target, `${GENERATED_HEADER}\n${body.join("\n").trimEnd()}\n`);
    }
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  for (const [target, content] of generate()) writeFileSync(join(ROOT, target), content);
}
