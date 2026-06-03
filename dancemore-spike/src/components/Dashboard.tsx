"use client";

import { useEffect, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { getStats, type Stats } from "@/lib/api";
import { scoreColor } from "@/lib/scoreColor";

export function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    getStats()
      .then(setStats)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (error)
    return <p style={{ color: "#ef4444" }}>Couldn’t load stats: {error}</p>;
  if (!stats) return <p style={{ color: "#888" }}>Loading stats…</p>;

  if (stats.total_attempts === 0) {
    return (
      <div style={{ textAlign: "center", color: "#888", padding: 48 }}>
        <div style={{ fontSize: "2rem", marginBottom: 8 }}>📈</div>
        Practice a move to start tracking your progress.
      </div>
    );
  }

  // Index the points so repeated dates (several attempts in a day) still plot
  // as distinct points in order; show the date in the tick/tooltip.
  const timeline = stats.timeline.map((p, i) => ({ ...p, i }));

  return (
    <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Headline row */}
      <div style={{ display: "flex", gap: 12 }}>
        <Stat
          label="Day streak"
          value={`${stats.current_streak} 🔥`}
          highlight={stats.current_streak > 0}
        />
        <Stat label="Total attempts" value={String(stats.total_attempts)} />
        <Stat
          label="Average score"
          value={String(stats.average_score)}
          color={scoreColor(stats.average_score)}
        />
      </div>

      {/* Score over time — the centerpiece */}
      <div style={panel}>
        <div style={panelTitle}>Score over time</div>
        <div style={{ width: "100%", height: 260 }}>
          <ResponsiveContainer>
            <AreaChart data={timeline} margin={{ top: 8, right: 12, bottom: 0, left: -20 }}>
              <defs>
                <linearGradient id="scoreFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#22c55e" stopOpacity={0.25} />
                  <stop offset="100%" stopColor="#22c55e" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#222" strokeDasharray="3 3" />
              <XAxis
                dataKey="i"
                tickFormatter={(i: number) => timeline[i]?.date.slice(5) ?? ""}
                tick={{ fill: "#888", fontSize: 11 }}
                stroke="#444"
                interval="preserveStartEnd"
                minTickGap={28}
              />
              <YAxis
                domain={[0, 100]}
                tick={{ fill: "#888", fontSize: 11 }}
                stroke="#444"
              />
              <Tooltip
                contentStyle={{
                  background: "#111",
                  border: "1px solid #333",
                  borderRadius: 6,
                  color: "#fff",
                }}
                labelFormatter={(i) => timeline[Number(i)]?.date ?? ""}
                formatter={(value) => [String(value), "Score"]}
              />
              <Area
                type="monotone"
                dataKey="score"
                stroke="#22c55e"
                strokeWidth={2.5}
                fill="url(#scoreFill)"
                dot={{ r: 2.5, fill: "#22c55e", strokeWidth: 0 }}
                activeDot={{ r: 5 }}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Per-move mastery */}
      <div style={panel}>
        <div style={panelTitle}>Move mastery</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {stats.moves.map((m) => (
            <div key={m.move_id}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: "0.9rem",
                  marginBottom: 4,
                }}
              >
                <span>{m.move_name}</span>
                <span style={{ color: "#888" }}>
                  best{" "}
                  <strong style={{ color: scoreColor(m.best_score) }}>
                    {m.best_score}
                  </strong>{" "}
                  · {m.attempts} attempt{m.attempts === 1 ? "" : "s"}
                </span>
              </div>
              <div
                style={{
                  height: 10,
                  background: "#1a1a1a",
                  borderRadius: 5,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${m.best_score}%`,
                    height: "100%",
                    background: scoreColor(m.best_score),
                    borderRadius: 5,
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  color,
  highlight,
}: {
  label: string;
  value: string;
  color?: string;
  highlight?: boolean;
}) {
  return (
    <div
      style={{
        ...panel,
        flex: 1,
        textAlign: "center",
        padding: "16px 8px",
        ...(highlight && {
          border: "1px solid #78350f",
          background: "linear-gradient(180deg, #1c1306 0%, #111 100%)",
        }),
      }}
    >
      <div style={{ fontSize: "2rem", fontWeight: 800, color: color ?? "#fff" }}>
        {value}
      </div>
      <div style={{ color: "#888", fontSize: "0.85rem" }}>{label}</div>
    </div>
  );
}

const panel: React.CSSProperties = {
  padding: 16,
  borderRadius: 8,
  border: "1px solid #333",
  background: "#111",
};

const panelTitle: React.CSSProperties = {
  fontWeight: 700,
  marginBottom: 12,
  fontSize: "0.95rem",
};
