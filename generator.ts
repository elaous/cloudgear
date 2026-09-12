import { Node, Project, SyntaxKind, type NewExpression } from "ts-morph";
import path from "node:path";
import fs from "node:fs";
import type { CollectedResource } from "./types";
import { stringifyToml } from "./toml";

// Walks one source file's AST for `new <provider>.<ResourceType>(name, ...)`
// calls. Only string-literal arguments are extracted -- anything else
// (a variable, an object literal, a nested call) is recorded as null so a
// plugin can reject it explicitly, rather than this parser guessing at a
// value from source text that isn't actually a plain string.
export async function parseAstForResources(
  sourceFilePath: string,
): Promise<CollectedResource[]> {
  const project = new Project();
  const sourceFile = project.addSourceFileAtPath(sourceFilePath);
  const resources: CollectedResource[] = [];

  sourceFile.forEachDescendant((node) => {
    if (node.getKind() !== SyntaxKind.NewExpression) return;
    const newExpr = node as NewExpression;
    const exprText = newExpr.getExpression().getText();

    // Namespaced form only (`provider.ResourceType`) -- a bare
    // `new ResourceType(...)` has no provider to dispatch on, and silently
    // skipping it would drop a resource from the generated stack with no
    // sign anything went wrong.
    const dot = exprText.lastIndexOf(".");
    if (dot === -1) {
      throw new Error(
        `Resource declaration "${exprText}(...)" must be namespaced as "<provider>.<ResourceType>(...)", e.g. "aws.Lambda(...)"`,
      );
    }
    const provider = exprText.slice(0, dot);
    const resourceType = exprText.slice(dot + 1);

    const ctorArgs = newExpr.getArguments();
    const nameArg = ctorArgs[0];
    if (!nameArg || !Node.isStringLiteral(nameArg)) {
      throw new Error(
        `${exprText}(...): first argument (the resource's name) must be a plain string literal, got: ${nameArg?.getText() ?? "nothing"}`,
      );
    }
    const name = nameArg.getLiteralValue();

    const args = ctorArgs
      .slice(1)
      .map((arg) => (Node.isStringLiteral(arg) ? arg.getLiteralValue() : null));

    resources.push({ provider, type: resourceType, name, arguments: args });
  });

  return resources;
}

// One plugin file per resource type, imported only for the types actually
// present in the parsed source -- a project using ten resource types but
// declaring two pays the parse/generate cost of two, not ten. Dynamic
// import() caches per resolved URL, so declaring the same type twice
// doesn't re-import its plugin.
export async function generateInfraFiles(
  resources: CollectedResource[],
  outDir: string = process.cwd(),
): Promise<void> {
  const stackBindings: string[] = [];

  for (const res of resources) {
    // Resolved relative to THIS module's own location, not process.cwd() --
    // a relative specifier in a dynamic import() resolves against the
    // importing module, and generator.ts is not guaranteed to be the
    // process's working directory (a global install, a different invoking
    // cwd, a bundled build all break that assumption).
    const pluginUrl = new URL(`./plugins/${res.type}.ts`, import.meta.url);
    if (!fs.existsSync(pluginUrl)) {
      throw new Error(
        `No plugin found for resource type "${res.type}" (looked for ${pluginUrl.pathname})`,
      );
    }

    const pluginModule = await import(pluginUrl.href);
    const generateCode = pluginModule.default;
    if (typeof generateCode !== "function") {
      throw new Error(
        `Plugin for "${res.type}" does not export a default generator function`,
      );
    }

    stackBindings.push(generateCode(res));
  }

  const cdkTemplate = `
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

export class GeneratedStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
${stackBindings.join("\n")}
  }
}
`;

  await Bun.write(
    path.join(outDir, "generated-stack.ts"),
    cdkTemplate.trim() + "\n",
  );

  const awsResources: Record<string, Record<string, unknown>> = {};
  for (const res of resources) {
    const byType = (awsResources[res.type] ??= {});
    byType[res.name] = { url: "PENDING_PROVISION" };
  }
  const structure = { aws: awsResources };

  await Bun.write(
    path.join(outDir, "resources.toml"),
    stringifyToml(structure),
  );
}
