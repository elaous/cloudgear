export default async function (request: { method: string; url: string }, response: { json(body: unknown): void; status(code: number): { json(body: unknown): void } }) {
  response.status(200).json({ method: request.method, url: request.url });
}
