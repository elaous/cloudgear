type Respond = (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => unknown;
type Req = { query: Record<string, string>; method: string; url: string; body: unknown; cookies: Record<string, string> };

export default async function (request: Req, response: Respond) {
  return response(
    { slug: request.query.slug, x: request.query.x, method: request.method, url: request.url, body: request.body, cookie: request.cookies.a },
    { status: 201, headers: { "x-slug": request.query.slug } },
  );
}
