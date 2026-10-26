import { useEffect, useState, type ReactNode } from "react";
import { STARTUP_PHASES, type StartupPhase, type StartupStatus } from "../../shared/startup";
import { useI18n } from "../lib/i18n";
import { browserSafeDiagnostic } from "../lib/browserDiagnostic";
import { Brand } from "./Sidebar";
import "./StartupGate.css";

export function StartupGate({ children }: { children: ReactNode }) {
  const { t, locale } = useI18n();
  const [state, setState] = useState<StartupStatus | null>(null);
  const [ready, setReady] = useState(false);
  const [disconnected, setDisconnected] = useState(false);
  useEffect(() => {
    try { document.documentElement.dataset.theme = localStorage.getItem("tokenatlas.theme") === "light" ? "light" : "dark"; }
    catch { document.documentElement.dataset.theme = "dark"; }
    let active = true;
    let pending = false;
    const controller = new AbortController();
    const poll = async () => {
      if (pending || !active) return;
      pending = true;
      try {
        const response = await fetch("/api/startup", { cache: "no-store",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3_000)]) });
        if (!active) return;
        // The ordinary application server has no preparation endpoint.
        if (response.status === 404) { window.clearInterval(timer); setReady(true); return; }
        if (!response.ok) throw new Error(`Startup status ${response.status}`);
        const next = await response.json() as StartupStatus;
        if (!STARTUP_PHASES.includes(next.phase)) throw new Error("Invalid startup status");
        if (!active) return;
        setState(next);
        setDisconnected(false);
      } catch {
        if (active) setDisconnected(true);
      } finally { pending = false; }
    };
    const timer = window.setInterval(() => void poll(), 500);
    void poll();
    return () => { active = false; window.clearInterval(timer); controller.abort(); };
  }, []);
  if (ready) return children;
  const labels: Record<StartupPhase, string> = {
    "migration-check": t("Checking the database", "Sprawdzanie bazy"),
    "snapshot-wait": t("Waiting for the snapshot", "Oczekiwanie na kopię"),
    "snapshot-copy": t("Database snapshot", "Kopia bazy"),
    "snapshot-validation": t("Checking the snapshot", "Sprawdzanie kopii"),
    "snapshot-checksum": t("Snapshot checksum", "Suma kontrolna kopii"),
    "snapshot-publication": t("Saving the snapshot", "Zapisywanie kopii"),
    "snapshot-retention": t("Removing the older snapshot", "Usuwanie starszej kopii"),
    migration: t("Database migrations", "Migracje bazy"),
    configuration: t("Checking configuration", "Sprawdzanie konfiguracji"),
    server: t("Starting tokenAtlas", "Uruchamianie tokenAtlas"),
    failed: t("Startup failed", "Start nieudany"),
  };
  const stoppedAt = state?.phase === "failed" ? Date.parse(state.stageStartedAt) : Date.now();
  const elapsed = state ? Math.max(0, Math.floor((stoppedAt - Date.parse(state.startedAt)) / 1000)) : 0;
  const label = disconnected ? t("Connecting", "Łączenie") : labels[state?.phase ?? "server"];
  const gb = (bytes: number) => (bytes / 1_000_000_000).toLocaleString(locale, { maximumFractionDigits: 2 });
  // Hold below 100% until SQLite finishes the backup, even if the source grew during startup.
  const copying = state?.phase === "snapshot-copy" && state.snapshotBytes != null && state.snapshotTotalBytes != null;
  const percent = copying ? Math.min(99, Math.floor(state.snapshotBytes! / state.snapshotTotalBytes! * 100)) : null;
  const migrations = state?.snapshotMigrations?.length ? state.snapshotMigrations.join(", ") : null;
  return <div className="first-run">
    <section className="ui-card first-run-panel startup-panel" aria-busy={state?.phase !== "failed"}>
      <Brand />
      <output className="startup-status" aria-live={state?.phase === "failed" ? "assertive" : "polite"}>
        {state?.phase !== "failed" && <span className="ui-loading-spinner" role="progressbar" aria-label={label}
          aria-valuemin={percent != null ? 0 : undefined} aria-valuemax={percent != null ? 100 : undefined}
          aria-valuenow={percent ?? undefined} />}
        <strong title={state?.error ? browserSafeDiagnostic(state.error) : undefined}>{label}</strong>
        <span className="mono">{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}</span>
        {state?.snapshotBytes != null && <span className="mono">
          {copying ? `${gb(state.snapshotBytes)} / ${gb(state.snapshotTotalBytes!)} GB` : `${gb(state.snapshotBytes)} GB`}
        </span>}
        {percent != null && <span className="mono">{percent}%</span>}
      </output>
      {migrations && <div className="startup-location mono"
        title={t("A pending migration is not declared additive, so a full database copy is made before it runs.",
          "Czekająca migracja nie jest oznaczona jako addytywna, więc przed nią powstaje pełna kopia bazy.")}>
        <span>{t("Reason", "Powód")}</span><span>{t("Migration", "Migracja")} {migrations}</span>
      </div>}
      {state?.snapshotDirectory && <div className="startup-location mono" title={state.snapshotDirectory}>
        <span>{t("Snapshots", "Kopie")}</span><span data-private="path">{state.snapshotDirectory}</span>
      </div>}
    </section>
  </div>;
}
