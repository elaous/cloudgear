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
router.add("GET", "/all", listAll);
router.add("get", "/check/{key}", check).add("HEAD", "/check/{key}", check, { name: "checkHead" });
