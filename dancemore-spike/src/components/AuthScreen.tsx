"use client";

import { useState } from "react";
import { login, register } from "@/lib/api";

// Minimal username + password screen, toggling between Login and Register.
export function AuthScreen({ onSuccess }: { onSuccess: () => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!username.trim() || !password) return;
    setBusy(true);
    setError("");
    try {
      if (mode === "login") await login(username.trim(), password);
      else await register(username.trim(), password);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        width: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 28,
        paddingTop: 40,
      }}
    >
      {/* Landing treatment — the first thing anyone sees. */}
      <div style={{ textAlign: "center", display: "flex", flexDirection: "column", gap: 10 }}>
        <div className="wordmark" style={{ fontSize: "3.25rem", lineHeight: 1 }}>
          DanceMore
        </div>
        <div style={{ color: "#bbb", fontSize: "1.05rem" }}>
          Your AI dance coach — real-time pose scoring in the browser.
        </div>
        <div style={{ color: "#666", fontSize: "0.85rem" }}>
          Pick a move · follow the poses · watch your score climb
        </div>
      </div>

      <form
        onSubmit={submit}
        style={{
          width: "100%",
          maxWidth: 360,
          display: "flex",
          flexDirection: "column",
          gap: 12,
          padding: 24,
          borderRadius: 12,
          border: "1px solid #333",
          background: "#111",
        }}
      >
      <div style={{ fontSize: "1.15rem", fontWeight: 700, textAlign: "center" }}>
        {mode === "login" ? "Log in" : "Create account"}
      </div>

      <input
        type="text"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        placeholder="Username"
        autoComplete="username"
        style={input}
      />
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Password"
        autoComplete={mode === "login" ? "current-password" : "new-password"}
        style={input}
      />

      {error && (
        <div style={{ color: "#ef4444", fontSize: "0.9rem" }}>{error}</div>
      )}

      <button
        type="submit"
        disabled={busy || !username.trim() || !password}
        style={{
          padding: "11px 16px",
          fontSize: "0.95rem",
          fontWeight: 700,
          borderRadius: 8,
          border: "1px solid #14532d",
          background: "#16a34a",
          color: "#04130a",
          cursor: "pointer",
          opacity: busy || !username.trim() || !password ? 0.5 : 1,
        }}
      >
        {busy ? "…" : mode === "login" ? "Log in" : "Register"}
      </button>

      <button
        type="button"
        onClick={() => {
          setMode(mode === "login" ? "register" : "login");
          setError("");
        }}
        style={{
          background: "none",
          border: "none",
          color: "#888",
          cursor: "pointer",
          fontSize: "0.85rem",
        }}
      >
        {mode === "login"
          ? "No account? Register"
          : "Have an account? Log in"}
      </button>
      </form>
    </div>
  );
}

const input: React.CSSProperties = {
  padding: "10px 12px",
  fontSize: "1rem",
  borderRadius: 6,
  border: "1px solid #444",
  background: "#0a0a0a",
  color: "#fff",
};
