export const dbUrl = process.env.DB_URL;

export function region() {
  return process.env["REGION"] ?? "eu-west-1";
}

export function check() {
  if (!process.env.FEATURE_FLAG) return false;
  return typeof process.env.OTHER === "string";
}
