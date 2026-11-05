import {
  GetParameterCommand,
  GetParametersByPathCommand,
  GetParametersCommand,
  PutParameterCommand,
  SSMClient,
} from "@aws-sdk/client-ssm";
import type { SecretDriver, SecretDriverOptions } from "../driver";

interface Client {
  send(command: any): Promise<any>;
}

// GetParameters takes at most this many names.
const BATCH = 10;

export class SsmSecretDriver implements SecretDriver {
  constructor(
    private readonly client: Client,
    private readonly kmsKey?: string,
  ) {}

  async get(name: string): Promise<string | null> {
    try {
      const res = await this.client.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
      return res.Parameter?.Value ?? null;
    } catch (err) {
      if ((err as { name?: string }).name === "ParameterNotFound") return null;
      throw err;
    }
  }

  async getMany(names: string[]): Promise<Record<string, string>> {
    const found: Record<string, string> = {};
    for (let i = 0; i < names.length; i += BATCH) {
      const res = await this.client.send(new GetParametersCommand({ Names: names.slice(i, i + BATCH), WithDecryption: true }));
      for (const parameter of res.Parameters ?? []) found[parameter.Name] = parameter.Value;
    }
    return found;
  }

  async list(prefix: string): Promise<Record<string, string>> {
    return this.byPath(prefix, true);
  }

  async names(prefix: string): Promise<string[]> {
    return Object.keys(await this.byPath(prefix, false)).sort();
  }

  async put(name: string, value: string): Promise<void> {
    await this.client.send(new PutParameterCommand({ Name: name, Value: value, Type: "SecureString", Overwrite: true, KeyId: this.kmsKey }));
  }

  private async byPath(prefix: string, decrypt: boolean): Promise<Record<string, string>> {
    const found: Record<string, string> = {};
    let token: string | undefined;
    do {
      const res = await this.client.send(new GetParametersByPathCommand({ Path: prefix, WithDecryption: decrypt, NextToken: token }));
      for (const parameter of res.Parameters ?? []) found[parameter.Name] = parameter.Value;
      token = res.NextToken;
    } while (token);
    return found;
  }
}

export function createSsmDriver(options: SecretDriverOptions): SecretDriver {
  return new SsmSecretDriver(new SSMClient(options.region ? { region: options.region } : {}), options.kmsKey);
}
