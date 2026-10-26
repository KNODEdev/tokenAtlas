import { Pill } from "../ui";

/** Vendor dot, account name and the plan chip (its periods in the tooltip). */
export function SubscriptionName({ color, name, plan, tooltip }: { color: string; name: string; plan: string | null; tooltip: string | null }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--s-3)" }}>
      <span aria-hidden style={{ width: 7, height: 7, borderRadius: "var(--r-dot)", background: color, flexShrink: 0 }} />
      <span style={{ fontWeight: "var(--fw-semibold)", color: "var(--text)" }}>{name}</span>
      {(plan || tooltip) && (
        <span title={tooltip ?? undefined} style={{ cursor: tooltip ? "help" : undefined }}>
          <Pill>{plan ?? "—"}</Pill>
        </span>
      )}
    </span>
  );
}
