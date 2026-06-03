// Thin client for the dancemore-api Django backend. Stores the JWT access
// token in localStorage and attaches it as a Bearer header on every call.

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const TOKEN_KEY = "dancemore_token";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
  emitTokenChange();
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
  emitTokenChange();
}

// Token-change subscription so React can read auth state via
// useSyncExternalStore (login/logout re-render automatically).
const tokenListeners = new Set<() => void>();

export function subscribeToken(listener: () => void): () => void {
  tokenListeners.add(listener);
  return () => tokenListeners.delete(listener);
}

function emitTokenChange() {
  for (const l of tokenListeners) l();
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function api<T>(
  path: string,
  opts: { method?: string; body?: unknown; auth?: boolean } = {}
): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.auth !== false) {
    const token = getToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
  }
  const res = await fetch(`${BASE}/api${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && opts.auth !== false) {
    // Token missing/expired — force a clean re-login.
    clearToken();
    throw new ApiError(401, "Session expired — please log in again.");
  }
  if (!res.ok) {
    let detail = `Request failed (${res.status})`;
    try {
      const data = await res.json();
      // DRF errors come as {"field": ["msg"]} or {"detail": "msg"}.
      if (typeof data.detail === "string") detail = data.detail;
      else {
        const first = Object.values(data)[0];
        if (Array.isArray(first) && typeof first[0] === "string")
          detail = first[0];
      }
    } catch {
      /* keep generic message */
    }
    throw new ApiError(res.status, detail);
  }
  return (await res.json()) as T;
}

// ── Auth ────────────────────────────────────────────────────────────────────
type Tokens = { access: string; refresh: string };

export async function register(username: string, password: string) {
  const tokens = await api<Tokens>("/auth/register", {
    method: "POST",
    body: { username, password },
    auth: false,
  });
  setToken(tokens.access);
}

export async function login(username: string, password: string) {
  const tokens = await api<Tokens>("/auth/login", {
    method: "POST",
    body: { username, password },
    auth: false,
  });
  setToken(tokens.access);
}

// ── Attempts & stats ────────────────────────────────────────────────────────
export type CheckpointScore = { name: string; score: number };

export function saveAttempt(attempt: {
  move_id: string;
  move_name: string;
  overall_score: number;
  checkpoint_scores: CheckpointScore[];
}) {
  return api("/attempts", { method: "POST", body: attempt });
}

export type Stats = {
  total_attempts: number;
  average_score: number;
  current_streak: number;
  timeline: { date: string; score: number }[];
  moves: {
    move_id: string;
    move_name: string;
    best_score: number;
    attempts: number;
  }[];
};

export function getStats() {
  return api<Stats>("/stats");
}
