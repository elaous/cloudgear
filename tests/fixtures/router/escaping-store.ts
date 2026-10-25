import { FunctionRouter } from "@cloudgear/functions";
import { BlobStore as Store } from "@cloudgear/blob";

// cloudgear: dry
const store = new Store("aws", "s3://shared");

async function useStore(target: Store) {
  return target.list();
}

export const listAll = async () => useStore(store);

export async function check(input: { key: string }) {
  return { exists: await store.exists(input.key) };
}

const router = new FunctionRouter("aws");
router.url("GET", "/all", listAll);
router.url("get", "/check/{key}", check).url("HEAD", "/check/{key}", check, { name: "checkHead" });
