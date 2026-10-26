import fs from "node:fs";

type Respond = (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => unknown;

export default async function (request: { query: { slug: string }; method: string }, response: Respond) {
  const html = fs.readFileSync("dist/index.html", "utf8").trim();
  return response({ slug: request.query.slug, method: request.method, html }, { status: 201, headers: { "x-slug": request.query.slug } });
}
