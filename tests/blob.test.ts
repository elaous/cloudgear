import { describe, expect, test } from "bun:test";
import { BlobStore, MemoryBlobDriver, blobEnvVar, parseBlobUri } from "@cloudgear/blob";

describe("parseBlobUri", () => {
  test("accepts a bare or provider-matching scheme", () => {
    expect(parseBlobUri("aws", "://myblob")).toBe("myblob");
    expect(parseBlobUri("aws", "s3://myblob")).toBe("myblob");
    expect(parseBlobUri("gcp", "gs://bucket")).toBe("bucket");
  });

  test("rejects a scheme from another provider and malformed URIs", () => {
    expect(() => parseBlobUri("aws", "gs://bucket")).toThrow(/expects "s3"/);
    expect(() => parseBlobUri("aws", "myblob")).toThrow(/Invalid blob URI/);
    expect(() => parseBlobUri("aws", "://a/b")).toThrow(/Invalid blob URI/);
  });
});

describe("BlobStore", () => {
  test("round-trips text, JSON and bytes", async () => {
    const store = new BlobStore("aws", "://test", new MemoryBlobDriver());
    await store.put("a.txt", "hello");
    await store.put("b.json", { n: 1 });
    await store.put("c.bin", new Uint8Array([1, 2]));

    expect(await store.getText("a.txt")).toBe("hello");
    expect(await store.getJson<{ n: number }>("b.json")).toEqual({ n: 1 });
    expect(await store.get("c.bin")).toEqual(new Uint8Array([1, 2]));
    expect(await store.get("missing")).toBeNull();
    expect(await store.exists("a.txt")).toBe(true);
    expect(await store.list()).toEqual(["a.txt", "b.json", "c.bin"]);

    await store.delete("a.txt");
    expect(await store.exists("a.txt")).toBe(false);
  });

  test("resolves the physical bucket from its env var", () => {
    const store = new BlobStore("aws", "://my-blob");
    expect(blobEnvVar("my-blob")).toBe("CLOUDGEAR_BLOB_MY_BLOB");
    expect(store.bucket).toBe("my-blob");
    process.env.CLOUDGEAR_BLOB_MY_BLOB = "real-bucket";
    try {
      expect(store.bucket).toBe("real-bucket");
    } finally {
      delete process.env.CLOUDGEAR_BLOB_MY_BLOB;
    }
  });
});
