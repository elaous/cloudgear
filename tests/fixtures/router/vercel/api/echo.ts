type Respond = (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => unknown;

export default async function (request: Request, response: Respond, { slug }: { slug: string }) {
  return response(
    { slug, method: request.method, path: new URL(request.url).pathname, query: new URL(request.url).search, body: await request.text(), respond: typeof response },
    { status: 201, headers: { "x-slug": slug } },
  );
}
