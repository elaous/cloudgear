export default async function handler() {
  return { ok: process.env.CRON_SECRET };
}
