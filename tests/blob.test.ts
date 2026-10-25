import { afterEach, describe, expect, test } from "bun:test";
import {
  BLOB_OPERATIONS,
  BlobStore,
  grant,
  normalizeBlobPath,
  registerBlobDriver,
  parseBlobUri,
  type BlobDriver,
} from "@cloudgear/blob";
import { MemoryBlobDriver } from "@cloudgear/blob/drivers/memory";
import { S3BlobDriver } from "@cloudgear/blob/drivers/s3";

describe("parseBlobUri", () => {
  test("accepts a bare or provider-matching scheme", () => {
    expect(parseBlobUri("aws", "://myblob")).toBe("myblob");
    expect(parseBlobUri("aws", "s3://myblob")).toBe("myblob");
    expect(parseBlobUri("gcp", "gs://bucket")).toBe("bucket");
    expect(parseBlobUri("azure", "az://container")).toBe("container");
  });

  test("rejects a scheme from another provider and malformed URIs", () => {
    expect(() => parseBlobUri("aws", "gs://bucket")).toThrow(/expects "s3"/);
    expect(() => parseBlobUri("aws", "myblob")).toThrow(/Invalid blob URI/);
    expect(() => parseBlobUri("aws", "://a/b")).toThrow(/Invalid blob URI/);
  });
});

describe("BlobStore", () => {
  test("round-trips text, JSON and bytes through any driver", async () => {
    const store = new BlobStore("aws", "://test", { driver: new MemoryBlobDriver() });
    await store.put("a.txt", "hello");
    await store.put("b.json", { n: 1 });
    await store.put("c.bin", new Uint8Array([1, 2]));

    expect(await store.getText("a.txt")).toBe("hello");
    expect(await store.getJson<{ n: number }>("b.json")).toEqual({ n: 1 });
    expect(await store.get("c.bin")).toEqual(new Uint8Array([1, 2]));
    expect(await store.get("missing")).toBeNull();
    expect(await store.getText("missing")).toBeNull();
    expect(await store.getJson("missing")).toBeNull();
    expect(await store.exists("a.txt")).toBe(true);
    expect(await store.list()).toEqual(["a.txt", "b.json", "c.bin"]);
    expect(await store.list("b")).toEqual(["b.json"]);

    await store.delete("a.txt");
    expect(await store.exists("a.txt")).toBe(false);
  });

  test("sets a default content type per payload kind and honours an override", async () => {
    const puts: [string, string | undefined][] = [];
    const driver: BlobDriver = {
      ...new MemoryBlobDriver(),
      put: async (key, _data, contentType) => void puts.push([key, contentType]),
    } as BlobDriver;
    const store = new BlobStore("aws", "://ct", { driver });
    await store.put("t", "x");
    await store.put("j", { a: 1 });
    await store.put("b", new Uint8Array(1));
    await store.put("o", "x", { contentType: "text/csv" });
    expect(puts).toEqual([["t", "text/plain"], ["j", "application/json"], ["b", undefined], ["o", "text/csv"]]);
  });

  describe("driver resolution", () => {
    const original = process.env.CLOUDGEAR_BLOB_DRIVER;
    afterEach(() => {
      if (original === undefined) delete process.env.CLOUDGEAR_BLOB_DRIVER;
      else process.env.CLOUDGEAR_BLOB_DRIVER = original;
      delete process.env.CLOUDGEAR_BLOB_RESOLVE_ME;
    });

    test("uses a registered provider driver, created lazily with the physical location", async () => {
      const created: string[] = [];
      registerBlobDriver("gcp", (location) => {
        created.push(location);
        return new MemoryBlobDriver();
      });
      const store = new BlobStore("gcp", "gs://resolve-me");
      expect(created).toEqual([]);

      process.env.CLOUDGEAR_BLOB_RESOLVE_ME = "real-bucket";
      await store.put("k", "v");
      await store.get("k");
      expect(created).toEqual(["real-bucket"]);
    });

    test("fails clearly for a provider with no driver, and retries after a failure", async () => {
      const store = new BlobStore("azure", "az://nowhere");
      await expect(store.get("k")).rejects.toThrow(/No blob driver for provider "azure"/);

      registerBlobDriver("azure", () => new MemoryBlobDriver());
      await expect(store.exists("k")).resolves.toBe(false);
    });

    test("CLOUDGEAR_BLOB_DRIVER=memory shares data per location across instances", async () => {
      process.env.CLOUDGEAR_BLOB_DRIVER = "memory";
      await new BlobStore("aws", "://shared-mem").put("k", "v");
      expect(await new BlobStore("aws", "://shared-mem").getText("k")).toBe("v");
      expect(await new BlobStore("aws", "://other-mem").getText("k")).toBeNull();
    });
  });

  test("location comes from the generated env var, falling back to the name", () => {
    const store = new BlobStore("aws", "://my-blob");
    expect(BlobStore.envVarFor("my-blob")).toBe("CLOUDGEAR_BLOB_MY_BLOB");
    expect(store.location).toBe("my-blob");
    process.env.CLOUDGEAR_BLOB_MY_BLOB = "real-bucket";
    try {
      expect(store.location).toBe("real-bucket");
    } finally {
      delete process.env.CLOUDGEAR_BLOB_MY_BLOB;
    }
  });

  test("BLOB_OPERATIONS names only real methods", () => {
    for (const method of Object.keys(BLOB_OPERATIONS)) {
      expect(typeof (BlobStore.prototype as any)[method]).toBe("function");
    }
  });
});

describe("BlobStore path prefix", () => {
  test("normalizeBlobPath accepts slashes either way and rejects odd segments", () => {
    expect(normalizeBlobPath("/img-cache/")).toBe("img-cache/");
    expect(normalizeBlobPath("img-cache")).toBe("img-cache/");
    expect(normalizeBlobPath("a/b")).toBe("a/b/");
    expect(normalizeBlobPath("/")).toBe("");
    expect(normalizeBlobPath("")).toBe("");
    for (const bad of ["a//b", "../x", "a/./b", "a/../b"]) expect(() => normalizeBlobPath(bad)).toThrow(/Invalid blob path/);
  });

  test("keys are stored under the prefix and list() strips it again", async () => {
    const shared = new MemoryBlobDriver();
    const root = new BlobStore("aws", "://bucket", { driver: shared });
    const images = new BlobStore("aws", "://bucket", { path: "/img-cache/", driver: shared });
    await root.put("other.txt", "outside");
    await images.put("a.png", "A");
    await images.put("nested/b.png", "B");

    expect(await root.list()).toEqual(["img-cache/a.png", "img-cache/nested/b.png", "other.txt"]);
    expect(await images.list()).toEqual(["a.png", "nested/b.png"]);
    expect(await images.list("nested/")).toEqual(["nested/b.png"]);
    expect(await images.getText("a.png")).toBe("A");
    expect(await images.exists("other.txt")).toBe(false);
    expect(await images.getText("other.txt")).toBeNull();

    await images.delete("a.png");
    expect(await root.exists("img-cache/a.png")).toBe(false);
    expect(images.path).toBe("img-cache/");
  });

  test("grant is a runtime no-op", () => {
    expect(grant(new BlobStore("aws", "://g"), "read", "write")).toBeUndefined();
  });
});

describe("S3BlobDriver", () => {
  const client = (respond: (name: string, input: any) => any) =>
    ({ send: async (command: any) => respond(command.constructor.name, command.input) }) as any;
  const notFound = (name: string) => Object.assign(new Error(name), { name });

  test("maps missing keys to null/false and rethrows other errors", async () => {
    const missing = new S3BlobDriver("b", client(() => { throw notFound("NoSuchKey"); }));
    expect(await missing.get("k")).toBeNull();
    const head = new S3BlobDriver("b", client(() => { throw notFound("NotFound"); }));
    expect(await head.exists("k")).toBe(false);

    const denied = new S3BlobDriver("b", client(() => { throw notFound("AccessDenied"); }));
    await expect(denied.get("k")).rejects.toThrow("AccessDenied");
    await expect(denied.exists("k")).rejects.toThrow("AccessDenied");
  });

  test("sends bucket, key and content type, and pages through list results", async () => {
    const seen: any[] = [];
    const driver = new S3BlobDriver(
      "bucket",
      client((name, input) => {
        seen.push([name, input]);
        if (name === "ListObjectsV2Command") {
          return input.ContinuationToken
            ? { Contents: [{ Key: "b" }] }
            : { Contents: [{ Key: "a" }], NextContinuationToken: "t" };
        }
        return {};
      }),
    );
    await driver.put("k", new Uint8Array([1]), "text/plain");
    expect(seen[0]).toEqual(["PutObjectCommand", { Bucket: "bucket", Key: "k", Body: new Uint8Array([1]), ContentType: "text/plain" }]);
    expect(await driver.list("p")).toEqual(["a", "b"]);
    expect(seen.filter(([n]) => n === "ListObjectsV2Command").map(([, i]) => i.Prefix)).toEqual(["p", "p"]);
  });
});
