"use client";

import { useState } from "react";

const ITEMS = [
  { label: "Neck rolls", detail: "5 slow circles each way" },
  { label: "Shoulder rolls", detail: "10 backwards, 10 forwards" },
  { label: "Arm circles", detail: "30 seconds, big and loose" },
  { label: "Hip circles", detail: "5 each direction" },
  { label: "Light bounce", detail: "30 seconds on the spot" },
];

// Shown once per day before the first practice. "Start practicing" unlocks
// when every item is checked; the skip link keeps a demo from ever blocking.
export function WarmupChecklist({
  onStart,
  onSkip,
}: {
  onStart: () => void;
  onSkip: () => void;
}) {
  const [checked, setChecked] = useState<boolean[]>(ITEMS.map(() => false));
  const allDone = checked.every(Boolean);

  return (
    <div
      style={{
        width: "100%",
        maxWidth: 440,
        display: "flex",
        flexDirection: "column",
        gap: 16,
        padding: 24,
        borderRadius: 12,
        border: "1px solid #333",
        background: "#111",
      }}
    >
      <div>
        <div style={{ fontSize: "1.35rem", fontWeight: 700 }}>
          Warm up first 🤸
        </div>
        <p style={{ color: "#888", fontSize: "0.9rem", marginTop: 6 }}>
          Two minutes of warmup wakes up your joints and muscles — it’s the
          easiest way to prevent dance injuries and you’ll score better too.
        </p>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {ITEMS.map((item, i) => (
          <label
            key={item.label}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "10px 14px",
              borderRadius: 8,
              border: `1px solid ${checked[i] ? "#14532d" : "#333"}`,
              background: checked[i] ? "#0c1f13" : "#1a1a1a",
              cursor: "pointer",
              transition: "background-color 0.15s ease, border-color 0.15s ease",
            }}
          >
            <input
              type="checkbox"
              checked={checked[i]}
              onChange={() =>
                setChecked((prev) => prev.map((c, j) => (j === i ? !c : c)))
              }
              style={{ width: 16, height: 16, accentColor: "#4ade80" }}
            />
            <span style={{ flex: 1 }}>
              <span
                style={{
                  fontWeight: 600,
                  color: checked[i] ? "#4ade80" : "#ededed",
                }}
              >
                {item.label}
              </span>
              <span style={{ color: "#888", fontSize: "0.85rem" }}>
                {" — "}
                {item.detail}
              </span>
            </span>
          </label>
        ))}
      </div>

      <button
        onClick={onStart}
        disabled={!allDone}
        style={{
          padding: "12px 16px",
          fontSize: "1rem",
          fontWeight: 700,
          borderRadius: 8,
          border: "1px solid #14532d",
          background: allDone ? "#16a34a" : "#1a1a1a",
          color: allDone ? "#04130a" : "#666",
          cursor: allDone ? "pointer" : "not-allowed",
        }}
      >
        {allDone ? "Start practicing →" : `${checked.filter(Boolean).length}/${ITEMS.length} done`}
      </button>

      <button
        onClick={onSkip}
        style={{
          background: "none",
          border: "none",
          color: "#666",
          cursor: "pointer",
          fontSize: "0.85rem",
        }}
      >
        Skip for now
      </button>
    </div>
  );
}
