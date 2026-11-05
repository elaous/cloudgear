import {
  CreateSecretCommand,
  GetSecretValueCommand,
  ListSecretsCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import type { SecretDriver, SecretDriverOptions } from "../driver";

interface Client {
  send(command: any): Promise<any>;
}

const notFound = (err: unknown) => (err as { name?: string }).name === "ResourceNotFoundException";

export class SecretsManagerDriver implements SecretDriver {
  constructor(
    private readonly client: Client,
    private readonly kmsKey?: string,
  ) {}

  async get(name: string): Promise<string | null> {
    try {
      const res = await this.client.send(new GetSecretValueCommand({ SecretId: name }));
      return res.SecretString ?? null;
    } catch (err) {
      if (notFound(err)) return null;
      throw err;
    }
  }

  async getMany(names: string[]): Promise<Record<string, string>> {
    const values = await Promise.all(names.map((name) => this.get(name)));
    return Object.fromEntries(names.flatMap((name, i) => (values[i] === null ? [] : [[name, values[i]!]])));
  }

  async list(prefix: string): Promise<Record<string, string>> {
    return this.getMany(await this.names(prefix));
  }

  async names(prefix: string): Promise<string[]> {
    const found: string[] = [];
    let token: string | undefined;
    do {
      const res = await this.client.send(new ListSecretsCommand({ Filters: [{ Key: "name", Values: [`${prefix}/`] }], NextToken: token }));
      for (const secret of res.SecretList ?? []) {
        if (secret.Name.startsWith(`${prefix}/`) && !secret.Name.slice(prefix.length + 1).includes("/")) found.push(secret.Name);
      }
      token = res.NextToken;
    } while (token);
    return found.sort();
  }

  async put(name: string, value: string): Promise<void> {
    try {
      await this.client.send(new PutSecretValueCommand({ SecretId: name, SecretString: value }));
    } catch (err) {
      if (!notFound(err)) throw err;
      await this.client.send(new CreateSecretCommand({ Name: name, SecretString: value, KmsKeyId: this.kmsKey }));
    }
  }
}

export function createSecretsManagerDriver(options: SecretDriverOptions): SecretDriver {
  return new SecretsManagerDriver(new SecretsManagerClient(options.region ? { region: options.region } : {}), options.kmsKey);
}
