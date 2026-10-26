export default async function (request: Request, { other }: { other: string }) {
  return { other, method: request.method };
}
