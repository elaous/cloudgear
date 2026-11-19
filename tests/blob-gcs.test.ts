import { describe, expect, test } from "bun:test";
import { createBlobDriver } from "../packages/blob/driver";
import { GcsBlobDriver, type GcsClient } from "../packages/blob/drivers/gcs";

class NotFound extends Error {
  code = 404;
}

function fakeClient(objects: Record<string, string> = {}) {
  const calls: string[] = [];
  const files = new Map<string, Uint8Array>(Object.entries(objects).map(([key, value]) => [key, new TextEncoder().encode(value)]));
  const client: GcsClient = {
    bucket(name) {
      return {
        file(key) {
          return {
            async download() {
              calls.push(`download ${name}/${key}`);
              const found = files.get(key);
              if (!found) throw new NotFound("No such object");
              return [found];
            },
            async save(data, options) {
              calls.push(`save ${name}/${key} ${JSON.stringify(options)}`);
              files.set(key, data);
            },
            async delete(options) {
              calls.push(`delete ${name}/${key} ${JSON.stringify(options)}`);
              files.delete(key);
            },
            async exists() {
              return [files.has(key)];
            },
          };
        },
        async getFiles(options) {
          calls.push(`list ${name} ${JSON.stringify(options)}`);
          return [[...files.keys()].filter((key) => key.startsWith(options.prefix)).map((key) => ({ name: key }))];
        },
      };
    },
  };
  return { client, calls };
}

describe("GCS blob driver", () => {
  test("reads, writes, lists and deletes objects in its bucket", async () => {
    const { client, calls } = fakeClient({ "a/one.txt": "1", "a/two.txt": "2", "b/three.txt": "3" });
    const driver = new GcsBlobDriver("assets", client);
    expect(new TextDecoder().decode((await driver.get("a/one.txt"))!)).toBe("1");
    expect(await driver.get("missing")).toBeNull();
    expect(await driver.exists("a/one.txt")).toBe(true);
    expect(await driver.exists("nope")).toBe(false);
    expect(await driver.list("a/")).toEqual(["a/one.txt", "a/two.txt"]);
    await driver.put("c.txt", new TextEncoder().encode("x"), "text/plain");
    await driver.put("d.bin", new Uint8Array([1]));
    await driver.delete("a/one.txt");
    expect(calls).toContain('save assets/c.txt {"contentType":"text/plain","resumable":false}');
    expect(calls).toContain('save assets/d.bin {"resumable":false}');
    expect(calls).toContain('delete assets/a/one.txt {"ignoreNotFound":true}');
    expect(calls).toContain('list assets {"prefix":"a/","autoPaginate":true}');
    expect(await driver.exists("a/one.txt")).toBe(false);
    expect(driver.client).toBe(client);
  });

  test("an error other than not found is not hidden", async () => {
    const failing: GcsClient = {
      bucket: () => ({
        file: () => ({
          download: async () => {
            throw Object.assign(new Error("forbidden"), { code: 403 });
          },
          save: async () => {},
          delete: async () => {},
          exists: async () => [false],
        }),
        getFiles: async () => [[]],
      }),
    };
    await expect(new GcsBlobDriver("assets", failing).get("k")).rejects.toThrow("forbidden");
  });

  test("the gcp provider has a built-in driver, which makes no call until it is used", async () => {
    const saved = process.env.CLOUDGEAR_BLOB_DRIVER;
    delete process.env.CLOUDGEAR_BLOB_DRIVER;
    try {
      const driver = await createBlobDriver("gcp", "assets");
      expect(driver).toBeInstanceOf(GcsBlobDriver);
      expect(driver.client).toBeDefined();
    } finally {
      if (saved !== undefined) process.env.CLOUDGEAR_BLOB_DRIVER = saved;
    }
  });
});
