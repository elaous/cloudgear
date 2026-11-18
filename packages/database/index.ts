export type DatabaseProvider = "neon";

export const POSTGRES_VERSIONS = [14, 15, 16, 17] as const;
export type PostgresVersion = (typeof POSTGRES_VERSIONS)[number];

export interface DatabaseOptions {
  // Neon region id such as "aws-us-east-1"; omit to keep the project's region.
  region?: string;
  postgres?: PostgresVersion;
  // Without it, `cloudgear destroy` refuses to delete the database.
  allowDestroy?: boolean;
}

const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,62}[A-Za-z0-9]$|^[A-Za-z0-9]$/;
const REGION_ID = /^(aws|azure)-[a-z0-9]+(-[a-z0-9]+)+$/;

export function assertDatabaseName(name: string): void {
  if (!PROJECT_NAME.test(name)) throw new Error(`Invalid database name "${name}"; use 1-64 letters, digits, spaces, ".", "_" or "-"`);
}

export function assertRegionId(region: string): void {
  if (!REGION_ID.test(region)) throw new Error(`Invalid Neon region "${region}"; expected an id such as "aws-us-east-1"`);
}

// Constructing does nothing; `cloudgear apply` creates or adopts the database.
export class Database {
  constructor(
    readonly provider: DatabaseProvider,
    readonly name: string,
    readonly options: DatabaseOptions = {},
  ) {
    if (provider !== "neon") throw new Error(`Database provider "${provider}" is not supported yet (supported: neon)`);
    assertDatabaseName(name);
    if (options.region !== undefined) assertRegionId(options.region);
    if (options.postgres !== undefined && !POSTGRES_VERSIONS.includes(options.postgres)) {
      throw new Error(`Unsupported Postgres version ${options.postgres} (supported: ${POSTGRES_VERSIONS.join(", ")})`);
    }
  }
}
