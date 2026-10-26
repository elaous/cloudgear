import fs from "node:fs";

type Respond = (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => unknown;

export default async function (request: Request, response: Respond, { slug }: { slug: string }) {
  const html = fs.readFileSync("dist/index.html", "utf8").trim();
  return response({ slug, method: request.method, path: new URL(request.url).pathname, html }, { status: 201, headers: { "x-slug": slug } });
}
