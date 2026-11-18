export type StreamProvider = "aws";
export type StreamMode = "provisioned" | "on-demand";

export const DEFAULT_SHARDS = 1;
export const DEFAULT_RETENTION_HOURS = 24;

export interface StreamOptions {
  // Applies when the stream is created; an existing stream keeps its mode unless you set this.
  mode?: StreamMode;
  // Provisioned mode only; defaults to 1 on creation.
  shards?: number;
  // 24 to 8760; defaults to 24 on creation (longer retention costs extra).
  retentionHours?: number;
  // Without it, `cloudgear destroy` refuses to delete the stream and its data.
  allowDestroy?: boolean;
}

const STREAM_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

export function assertStreamName(name: string): void {
  if (!STREAM_NAME.test(name)) throw new Error(`Invalid stream name "${name}"; use 1-128 letters, digits, ".", "_" or "-"`);
}

// Constructing does nothing; `cloudgear apply` creates or adopts the stream.
export class Stream {
  constructor(
    readonly provider: StreamProvider,
    readonly name: string,
    readonly options: StreamOptions = {},
  ) {
    if (provider !== "aws") throw new Error(`Stream provider "${provider}" is not supported yet (supported: aws)`);
    assertStreamName(name);
    const { mode, shards, retentionHours } = options;
    if (mode !== undefined && mode !== "provisioned" && mode !== "on-demand") throw new Error(`Unsupported stream mode "${mode}" (supported: provisioned, on-demand)`);
    if (shards !== undefined) {
      if (!Number.isInteger(shards) || shards < 1 || shards > 10000) throw new Error(`shards must be a whole number from 1 to 10000; got ${shards}`);
      if (mode === "on-demand") throw new Error("shards only applies to provisioned mode");
    }
    if (retentionHours !== undefined && (!Number.isInteger(retentionHours) || retentionHours < 24 || retentionHours > 8760)) {
      throw new Error(`retentionHours must be a whole number from 24 to 8760; got ${retentionHours}`);
    }
  }
}
