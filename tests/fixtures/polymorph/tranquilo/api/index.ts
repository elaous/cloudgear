const optional = [
  "BLOB_USAGE_SOFT_CAP_BYTES",
  "CANONICAL_ORIGIN",
  "IMG_ADMIT_FASTPATH_REQUESTS",
  "IMG_ADMIT_FASTPATH_WINDOW_SECONDS",
  "ITEMS_CURSOR_SECRET",
  "OPS_ALERT_EMAIL",
  "PRINT_REGION_DEV_COUNTRY",
  "RESEND_FROM_EMAIL",
  "VERCEL_TEAM_ID",
  "SENTRY_DSN",
];

export default async function handler() {
  return {
    ok: process.env.DATABASE_URL,
    optional: [
      process.env.BLOB_USAGE_SOFT_CAP_BYTES ?? "",
      process.env.CANONICAL_ORIGIN ?? "",
      process.env.IMG_ADMIT_FASTPATH_REQUESTS ?? "",
      process.env.IMG_ADMIT_FASTPATH_WINDOW_SECONDS ?? "",
      process.env.ITEMS_CURSOR_SECRET ?? "",
      process.env.OPS_ALERT_EMAIL ?? "",
      process.env.PRINT_REGION_DEV_COUNTRY ?? "",
      process.env.RESEND_FROM_EMAIL ?? "",
      process.env.VERCEL_TEAM_ID ?? "",
      process.env.SENTRY_DSN ?? "",
    ].length + optional.length,
  };
}
