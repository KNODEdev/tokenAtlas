import { useRef, useState, type ReactNode, type RefObject } from "react";
import { useI18n } from "../lib/i18n";
import { copyCardImage, downloadImage, renderCardWebp } from "./card-png";

export function ChartExportControls({ targetRef, title, fileName = "tokenatlas-chart.webp" }: {
  targetRef: RefObject<HTMLDivElement | null>; title: string; fileName?: string;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const locked = useRef(false);
  async function capture(copy: boolean) {
    const node = targetRef.current;
    if (!node || locked.current) return;
    locked.current = true;
    setBusy(true); setStatus(""); setError("");
    try {
      if (copy) {
        const format = await copyCardImage(node, title);
        setStatus(format === "image/webp" ? t("WebP copied", "Skopiowano WebP") : t("PNG copied", "Skopiowano PNG"));
      } else {
        downloadImage(await renderCardWebp(node, title), fileName.replace(/\.(png|webp)$/i, "") + ".webp");
        setStatus(t("WebP saved", "Zapisano WebP"));
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("Export failed", "Eksport nieudany"));
    } finally { locked.current = false; setBusy(false); }
  }
  return <span data-capture-exclude="" style={{ display: "inline-flex", alignItems: "center", gap: "var(--s-3)", flexShrink: 0 }}>
    <span role={error ? "alert" : "status"} title={error || status} style={{ fontSize: "var(--fs-2)", color: error ? "var(--warn)" : "var(--muted)" }}>
      {error ? t("Export failed", "Eksport nieudany") : status}
    </span>
    <button type="button" className="ui-button" disabled={busy} onClick={() => void capture(true)}
      aria-label={`${t("Copy chart", "Kopiuj wykres")}: ${title}`}
      title={t("Copy image with tokenAtlas.dev · PNG when the clipboard does not support WebP", "Kopiuj obraz z tokenAtlas.dev · PNG, gdy schowek nie obsługuje WebP")}
      style={{ fontSize: "var(--fs-3)", padding: "var(--s-2) var(--s-4)" }}>{busy ? "…" : "⧉"}</button>
    <button type="button" className="ui-button" disabled={busy} onClick={() => void capture(false)}
      aria-label={`${t("Save WebP", "Zapisz WebP")}: ${title}`} title={t("Save WebP with tokenAtlas.dev", "Zapisz WebP z tokenAtlas.dev")}
      style={{ fontSize: "var(--fs-3)", padding: "var(--s-2) var(--s-4)" }}>↓ WebP</button>
  </span>;
}

/** Export the displayed chart and its legend; controls stay outside the captured node. */
export function ChartExport({ children, title, available = true }: { children: ReactNode; title: string; available?: boolean }) {
  const node = useRef<HTMLDivElement>(null);
  return <div style={{ minWidth: 0 }} data-chart-export="">
    <div ref={node} style={{ display: "flow-root", minWidth: 0 }}>{children}</div>
    {available && <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "var(--s-2)" }}>
      <ChartExportControls targetRef={node} title={title} />
    </div>}
  </div>;
}
