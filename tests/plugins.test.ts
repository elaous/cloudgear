import { describe, expect, test } from "bun:test";
import generateLambda from "../plugins/Lambda";
import generateDynamoTable from "../plugins/DynamoTable";
import type { CollectedResource } from "../types";

describe("plugins/Lambda", () => {
  test("generates a lambda.Function with the given handler", () => {
    const code = generateLambda({
      provider: "aws",
      type: "Lambda",
      name: "handler",
      arguments: ["./src/handler", "index.handler"],
    } satisfies CollectedResource);

    expect(code).toContain("const handler = new lambda.Function(this, 'handler'");
    expect(code).toContain("runtime: lambda.Runtime.NODEJS_20_X");
    expect(code).toContain("handler: 'index.handler'");
    expect(code).toContain("code: lambda.Code.fromAsset('./src/handler')");
  });

  test("defaults the handler to index.handler when omitted", () => {
    const code = generateLambda({
      provider: "aws",
      type: "Lambda",
      name: "fn",
      arguments: ["./src"],
    } satisfies CollectedResource);

    expect(code).toContain("handler: 'index.handler'");
  });

  test("throws when the code asset path is missing", () => {
    expect(() =>
      generateLambda({
        provider: "aws",
        type: "Lambda",
        name: "fn",
        arguments: [],
      } satisfies CollectedResource),
    ).toThrow(/code asset path.*plain string literal/);
  });

  test("throws when the code asset path was not a plain string literal", () => {
    expect(() =>
      generateLambda({
        provider: "aws",
        type: "Lambda",
        name: "fn",
        arguments: [null],
      } satisfies CollectedResource),
    ).toThrow(/fn.*code asset path/);
  });
});

describe("plugins/DynamoTable", () => {
  test("generates a dynamodb.Table with a custom partition key", () => {
    const code = generateDynamoTable({
      provider: "aws",
      type: "DynamoTable",
      name: "sessions",
      arguments: ["sessionId"],
    } satisfies CollectedResource);

    expect(code).toContain("const sessions = new dynamodb.Table(this, 'sessions'");
    expect(code).toContain("name: 'sessionId'");
    expect(code).toContain("type: dynamodb.AttributeType.STRING");
  });

  test("defaults the partition key to 'id' when omitted", () => {
    const code = generateDynamoTable({
      provider: "aws",
      type: "DynamoTable",
      name: "items",
      arguments: [],
    } satisfies CollectedResource);

    expect(code).toContain("name: 'id'");
  });

  test("defaults the partition key to 'id' when the argument wasn't a string literal", () => {
    const code = generateDynamoTable({
      provider: "aws",
      type: "DynamoTable",
      name: "items",
      arguments: [null],
    } satisfies CollectedResource);

    expect(code).toContain("name: 'id'");
  });
});
