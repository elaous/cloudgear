export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export type AwsCredentialsProvider = () => Promise<AwsCredentials>;

const FUNCTION_URL_HOST = /\.lambda-url\.([a-z0-9-]+)\.on\.aws$/;

export function regionFromUrl(url: string): string | undefined {
  return FUNCTION_URL_HOST.exec(new URL(url).hostname)?.[1];
}

// SigV4-signs a POST to a Lambda function URL; SDK packages load only when signing.
export async function signFunctionUrlRequest(
  url: string,
  body: string,
  headers: Record<string, string>,
  options: { credentials?: AwsCredentialsProvider; region?: string } = {},
): Promise<Record<string, string>> {
  const region = regionFromUrl(url) ?? options.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  if (!region) throw new Error(`Cannot determine the AWS region for ${url}; set the router's region option or AWS_REGION`);

  const [{ SignatureV4 }, { HttpRequest }, { Sha256 }] = await Promise.all([
    import("@smithy/signature-v4"),
    import("@smithy/protocol-http"),
    import("@aws-crypto/sha256-js"),
  ]);
  const credentials =
    options.credentials ?? (await import("@aws-sdk/credential-provider-node")).defaultProvider();

  const target = new URL(url);
  const signer = new SignatureV4({ credentials, region, service: "lambda", sha256: Sha256 });
  const signed = await signer.sign(
    new HttpRequest({
      method: "POST",
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port ? Number(target.port) : undefined,
      path: target.pathname,
      headers: { ...headers, host: target.host },
      body,
    }),
  );

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(signed.headers)) {
    if (key.toLowerCase() !== "host") out[key] = String(value);
  }
  return out;
}
