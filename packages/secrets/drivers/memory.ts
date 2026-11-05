import type { SecretDriver } from "../driver";

const stores = new Map<string, string>();

export class MemorySecretDriver implements SecretDriver {
  constructor(private readonly values = stores) {}

  async get(name: string) {
    return this.values.get(name) ?? null;
  }

  async getMany(names: string[]) {
    return Object.fromEntries(names.flatMap((name) => (this.values.has(name) ? [[name, this.values.get(name)!]] : [])));
  }

  async list(prefix: string) {
    return Object.fromEntries([...this.values].filter(([name]) => isDirectChild(name, prefix)));
  }

  async names(prefix: string) {
    return [...this.values.keys()].filter((name) => isDirectChild(name, prefix)).sort();
  }

  async put(name: string, value: string) {
    this.values.set(name, value);
  }
}

const isDirectChild = (name: string, prefix: string) => name.startsWith(`${prefix}/`) && !name.slice(prefix.length + 1).includes("/");

export function createMemorySecretDriver(): MemorySecretDriver {
  return new MemorySecretDriver();
}
