/**
 * Thin, typed wrapper around the Instantly.ai API (v2).
 *
 * Docs: https://developer.instantly.ai/api/v2
 * Base URL: https://api.instantly.ai/api/v2
 * Auth:     Authorization: Bearer <API_KEY>
 *
 * The API key is read from the INSTANTLY_API_KEY environment variable and is
 * only ever used server-side. It is never exposed to the MCP client (Claude).
 */

const DEFAULT_BASE_URL = "https://api.instantly.ai/api/v2";

export class InstantlyError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "InstantlyError";
    this.status = status;
    this.body = body;
  }
}

export interface InstantlyClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
}

export type QueryValue = string | number | boolean | undefined | null | Array<string | number>;
export type Query = Record<string, QueryValue>;

export interface RequestOptions {
  query?: Query;
  body?: unknown;
}

export class InstantlyClient {
  private apiKey: string;
  private baseUrl: string;
  private timeoutMs: number;

  constructor(opts: InstantlyClientOptions) {
    if (!opts.apiKey) {
      throw new Error("INSTANTLY_API_KEY is required to create an InstantlyClient.");
    }
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  private buildUrl(path: string, query?: Query): string {
    const cleanPath = path.startsWith("/") ? path : `/${path}`;
    const url = new URL(this.baseUrl + cleanPath);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) {
          // Instantly repeats the key for array params, e.g. ?id=a&id=b
          for (const item of value) url.searchParams.append(key, String(item));
        } else {
          url.searchParams.append(key, String(value));
        }
      }
    }
    return url.toString();
  }

  async request<T = unknown>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    opts: RequestOptions = {},
  ): Promise<T> {
    const url = this.buildUrl(path, opts.query);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
    };
    let bodyInit: string | undefined;
    if (opts.body !== undefined && method !== "GET") {
      headers["Content-Type"] = "application/json";
      bodyInit = JSON.stringify(opts.body);
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: bodyInit,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof Error && err.name === "AbortError") {
        throw new InstantlyError(0, `Request to Instantly timed out after ${this.timeoutMs}ms`, null);
      }
      throw new InstantlyError(0, `Network error calling Instantly: ${(err as Error).message}`, null);
    }
    clearTimeout(timeout);

    const text = await res.text();
    let parsed: unknown = text;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // leave as text
      }
    }

    if (!res.ok) {
      const msg =
        (parsed && typeof parsed === "object" && "message" in parsed
          ? String((parsed as Record<string, unknown>).message)
          : `Instantly API returned HTTP ${res.status}`);
      throw new InstantlyError(res.status, msg, parsed);
    }

    return parsed as T;
  }

  // ---- Convenience wrappers -------------------------------------------------

  get<T = unknown>(path: string, query?: Query) {
    return this.request<T>("GET", path, { query });
  }
  post<T = unknown>(path: string, body?: unknown, query?: Query) {
    return this.request<T>("POST", path, { body, query });
  }
}
