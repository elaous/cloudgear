import { BlobStore } from "@cloudgear/blob";

const data = new BlobStore("aws", "://script-data");

export default async ({ id }: { id: string }) => {
  await data.put(id, "saved");
  return { id };
};
