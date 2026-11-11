export interface ParsedArn {
  partition: string;
  service: string;
  region: string;
  account: string;
  resource: string;
}

// Resource part may contain colons and slashes.
export function parseArn(arn: string): ParsedArn | undefined {
  const match = /^arn:(aws(?:-[a-z]+)*):([a-z0-9-]+):([a-z0-9-]*):(\d*):(.+)$/.exec(arn);
  return match ? { partition: match[1]!, service: match[2]!, region: match[3]!, account: match[4]!, resource: match[5]! } : undefined;
}

export function expectArn(arn: string, service: string, what: string): ParsedArn {
  const parsed = parseArn(arn);
  if (!parsed || parsed.service !== service) throw new Error(`"${arn}" is not ${what} ARN`);
  return parsed;
}
