const loaders: Record<string, () => Promise<{ default: () => unknown }>> = {
  target: () => import("./lazy-target.ts"),
};

export default async function handler(req: { query: { part?: string } }) {
  return (await loaders[req.query.part ?? "target"]!()).default();
}
