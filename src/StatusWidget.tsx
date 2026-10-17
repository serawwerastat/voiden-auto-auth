import { useEffect, useState, type CSSProperties, type ComponentType } from "react";

import { hostModule } from "./host";
import { status, statusBarLabel, statusTooltip, type ServiceLabel } from "./status";

/** Re-render at least this often so the "42m" countdown stays current. */
const TICK_MS = 30_000;

const TONE_COLORS: Record<ServiceLabel["tone"], string | undefined> = {
  normal: undefined,
  dim: undefined,
  warning: "var(--status-warning, #f59e0b)",
  error: "var(--status-error, #ef4444)",
};

type IconComponent = ComponentType<{ size?: number }>;

/**
 * The status bar item. Voiden renders a plugin's status bar icon as a
 * component with a `size` prop, so the whole live label lives here.
 */
export function StatusWidget({ size = 14 }: { size?: number }) {
  const [, rerender] = useState(0);

  useEffect(() => {
    const bump = () => rerender((n) => n + 1);
    const unsubscribe = status.subscribe(bump);
    const timer = setInterval(bump, TICK_MS);
    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, []);

  const snapshot = status.get();
  const label = statusBarLabel(snapshot);
  const icons = hostModule<Record<string, IconComponent>>("lucide-react") ?? {};
  const Key = icons.KeyRound ?? icons.Key;

  const style: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    whiteSpace: "nowrap",
    color: TONE_COLORS[label.tone],
    opacity: label.tone === "dim" ? 0.7 : 1,
  };

  return (
    <span title={statusTooltip(snapshot)} style={style}>
      {Key ? <Key size={size} /> : "🔑"}
      <span style={{ fontSize: 11 }}>{label.text}</span>
    </span>
  );
}
