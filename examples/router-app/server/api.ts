import * as types from "server/types";
import { BlobStore } from "@cloudgear/blob";
import { response } from "@cloudgear/functions";
import { archive } from "server/storage";

const store = new BlobStore("aws", "://myblob"); // cloudgear: dry

export async function foo(input: types.FooInput): Promise<types.FooOutput> {
  const timestamp = new Date();
  await store.put(`foo/${input.param}.json`, { name: input.name, q: input.q, timestamp });
  await archiveEvent(input.param, timestamp);
  return { timestamp };
}

export async function getFoo(input: types.GetFooInput) {
  const item = await store.getJson<{ name: string }>(`foo/${input.param}.json`);
  return item ?? response({ error: "not found" }, { status: 404 });
}

export function health() {
  return { ok: true };
}

async function archiveEvent(param: string, at: Date) {
  await archive.put(`events/${at.toISOString()}-${param}`, param);
}
