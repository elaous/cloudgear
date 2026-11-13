import { BlobStore } from "@cloudgear/blob";
import type { VercelRequest, VercelResponse } from "@cloudgear/functions";

const store = new BlobStore("aws", "://mounted-data");

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.status(200).json({ value: await store.getText("key") });
}
