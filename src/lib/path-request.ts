/**
 * The one place the learning path screens speak HTTP. It returns what the server
 * said (status, the `code` a domain error carries, its prose, and any `problems`)
 * and never throws: a network failure is a result like any other, so a screen
 * always has something to show. The server's message is kept only when it is
 * short prose; the screens decide what a person is actually told.
 */

export type ApiFailure = {
  kind: "error";
  /** The HTTP status, or null when there was no answer at all. */
  status: number | null;
  code: string | null;
  /** The server's own `error` text, when it sent a short one. */
  serverMessage: string | null;
  problems: readonly unknown[];
};

export type ApiResult<T> = { kind: "ok"; data: T } | ApiFailure;

const MAX_SERVER_MESSAGE = 300;

function field(body: unknown, key: string): unknown {
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>)[key] : null;
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export async function requestJson<T>(
  url: string,
  init: RequestInit = {},
  fetchImpl: typeof fetch = fetch
): Promise<ApiResult<T>> {
  try {
    const res = await fetchImpl(url, init);
    const body = await readJson(res);
    if (res.ok) return { kind: "ok", data: body as T };

    const message = field(body, "error");
    const code = field(body, "code");
    const problems = field(body, "problems");
    return {
      kind: "error",
      status: res.status,
      code: typeof code === "string" ? code : null,
      serverMessage:
        typeof message === "string" && message.length > 0 && message.length < MAX_SERVER_MESSAGE
          ? message
          : null,
      problems: Array.isArray(problems) ? problems : [],
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    return { kind: "error", status: null, code: null, serverMessage: null, problems: [] };
  }
}

export function jsonInit(method: string, body?: unknown): RequestInit {
  return body === undefined
    ? { method }
    : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
