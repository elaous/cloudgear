export default async function handler() {
  return { ok: process.env.DATABASE_URL };
}
