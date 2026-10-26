type Res = { status(code: number): Res; setHeader(name: string, value: string): Res; json(body: unknown): Res };

export default async function (request: { query: Record<string, string> }, response: Res) {
  response.status(202).setHeader("x-written", "yes").json({ slug: request.query.slug });
}
