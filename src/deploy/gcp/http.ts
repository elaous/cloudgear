// A failed Google API call, with the HTTP status the way Google reported it.
export class GcpApiError extends Error {
  constructor(
    readonly status: number | undefined,
    message: string,
  ) {
    super(message);
  }
}

export interface GcpHttp {
  request(method: "GET" | "POST" | "PATCH" | "DELETE", url: string, body?: unknown): Promise<any>;
  // PUT to a signed URL; it carries its own authorization.
  upload(url: string, data: Uint8Array, headers: Record<string, string>): Promise<void>;
}

// Wraps an error from google-auth-library (gaxios) without keeping the request, which holds the token.
export function toApiError(err: unknown): GcpApiError {
  const e = err as { response?: { status?: number; data?: { error?: { message?: string } } }; status?: number; code?: unknown; message?: string };
  const status = e.response?.status ?? e.status ?? (typeof e.code === "number" ? e.code : undefined);
  const detail = e.response?.data?.error?.message ?? e.message ?? "request failed";
  return new GcpApiError(status, status ? `${detail} (HTTP ${status})` : detail);
}

interface AuthLike {
  request(options: { url: string; method: string; data?: unknown }): Promise<{ data: unknown }>;
}

export function httpFor(auth: AuthLike, send: typeof fetch = fetch): GcpHttp {
  return {
    async request(method, url, body) {
      try {
        return (await auth.request({ url, method, ...(body !== undefined ? { data: body } : {}) })).data;
      } catch (err) {
        throw toApiError(err);
      }
    },
    async upload(url, data, headers) {
      let res: Response;
      try {
        res = await send(url, { method: "PUT", headers, body: data });
      } catch {
        // The signed URL is a credential; keep it out of the message.
        throw new GcpApiError(undefined, "uploading the function's code failed: the connection failed");
      }
      if (!res.ok) throw new GcpApiError(res.status, `uploading the function's code failed (HTTP ${res.status})`);
    },
  };
}
