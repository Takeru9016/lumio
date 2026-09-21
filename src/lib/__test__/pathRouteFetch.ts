type RouteContext = { params: Promise<Record<string, string>> };
type Handler = (req: Request, ctx: RouteContext) => Promise<Response>;
type Module = Partial<Record<"GET" | "POST" | "PATCH" | "DELETE", Handler>>;

type Route = { pattern: RegExp; names: string[]; load: () => Promise<unknown> };

const route = (path: string, load: () => Promise<unknown>): Route => {
  const names: string[] = [];
  const source = path.replace(/\[(\w+)\]/g, (_, name: string) => {
    names.push(name);
    return "([^/]+)";
  });
  return { pattern: new RegExp(`^${source}$`), names, load };
};

const ROUTES: Route[] = [
  route("/api/org/paths", () => import("@/app/api/org/paths/route")),
  route("/api/org/paths/[pathId]", () => import("@/app/api/org/paths/[pathId]/route")),
  route(
    "/api/org/paths/[pathId]/courses",
    () => import("@/app/api/org/paths/[pathId]/courses/route")
  ),
  route(
    "/api/org/paths/[pathId]/courses/[courseId]",
    () => import("@/app/api/org/paths/[pathId]/courses/[courseId]/route")
  ),
  route(
    "/api/org/paths/[pathId]/reorder",
    () => import("@/app/api/org/paths/[pathId]/reorder/route")
  ),
  route(
    "/api/org/paths/[pathId]/publish",
    () => import("@/app/api/org/paths/[pathId]/publish/route")
  ),
  route(
    "/api/org/paths/[pathId]/archive",
    () => import("@/app/api/org/paths/[pathId]/archive/route")
  ),
  route("/api/paths", () => import("@/app/api/paths/route")),
  route("/api/paths/[pathId]", () => import("@/app/api/paths/[pathId]/route")),
];

export type SentRequest = { method: string; url: string; body: string | null };

/**
 * A `fetch` that answers the learning path clients by calling the real route
 * handlers in-process, so what a client sends is judged by the same code, the same
 * authorization and the same database as in production. Nothing is mocked but the
 * session (the test signs in through Clerk's `auth`). Every request is recorded.
 */
export function createRouteFetch(): { fetchImpl: typeof fetch; sent: SentRequest[] } {
  const sent: SentRequest[] = [];

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    sent.push({
      method,
      url: `${url.pathname}${url.search}`,
      body: (init?.body as string) ?? null,
    });

    for (const candidate of ROUTES) {
      const match = candidate.pattern.exec(url.pathname);
      if (!match) continue;
      const params = Object.fromEntries(
        candidate.names.map((name, i) => [name, decodeURIComponent(match[i + 1])])
      );
      const handler = ((await candidate.load()) as Module)[method as keyof Module];
      if (!handler) return new Response(null, { status: 405 });
      return handler(new Request(url, init), { params: Promise.resolve(params) });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  return { fetchImpl, sent };
}
