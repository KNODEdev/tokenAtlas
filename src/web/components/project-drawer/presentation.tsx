import { ChartExportControls } from "../ChartExport";
import type { ReactNode } from "react";
import { HelpBlock, HelpDot } from "../ui";
import { useI18n } from "../../lib/i18n";

export function CaptureControls({
  targetRef,
  fileName,
  label,
}: {
  targetRef: React.RefObject<HTMLDivElement | null>;
  fileName: string;
  label: string;
}) {
  return <ChartExportControls targetRef={targetRef} fileName={fileName} title={label} />;
}

/** Title of a group inside a drawer view; the project name is the drawer's only display-voice title. */
function SectionTitle({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: "var(--fs-5)", fontWeight: "var(--fw-semibold)", color: "var(--text)" }}>{children}</div>;
}

/** Chart card head: title with its explanation dot (left out of the PNG) and the capture buttons. */
export function ChartHead({ title, help, controls }: { title?: string; help: string; controls: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--s-3)", minWidth: 0 }}>
        {title && <SectionTitle>{title}</SectionTitle>}
        <span data-capture-exclude="" style={{ display: "inline-flex" }}>
          <HelpDot>
            <HelpBlock>{help}</HelpBlock>
          </HelpDot>
        </span>
      </div>
      {controls}
    </div>
  );
}

/**
 * One step of the drawer's answer: a question as the title, its controls on the right, the answer
 * below. Steps follow each other in one scroll, divided by a dashed rule.
 */
export function QuestionSection({
  title,
  help,
  controls,
  first,
  data,
  children,
}: {
  title: ReactNode;
  help?: ReactNode;
  controls?: ReactNode;
  first?: boolean;
  data: string;
  children?: ReactNode;
}) {
  return (
    <section
      data-section={data}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--s-7)",
        minWidth: 0,
        ...(first ? { paddingBottom: "var(--s-10)" } : { borderTop: "var(--rule)", padding: "var(--s-10) 0" }),
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--s-5)", flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s-4)", minWidth: 0 }}>
          {typeof title === "string" ? (
            <h2 style={{ margin: 0, fontSize: "var(--fs-6)", fontWeight: "var(--fw-semibold)", color: "var(--text)" }}>{title}</h2>
          ) : (
            title
          )}
          {help}
        </div>
        {controls && <div style={{ display: "flex", alignItems: "center", gap: "var(--s-4)", flexWrap: "wrap" }}>{controls}</div>}
      </div>
      {children}
    </section>
  );
}

export function ValuesToggle({ hidden, onToggle }: { hidden: boolean; onToggle: () => void }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={hidden}
      aria-label={hidden ? t("Show chart values", "Pokaż liczby na wykresach") : t("Hide chart values", "Ukryj liczby na wykresach")}
      title={
        hidden
          ? t(
              "Values on both charts are hidden, including in the exported image. Bar shapes, dates, and labels stay visible. Data and scale are unchanged. Click to show them.",
              "Liczby na obu wykresach są ukryte (także na eksportowanym obrazie). Kształt słupków, daty i opisy zostają — dane i skala są nietknięte. Kliknij, żeby je pokazać.",
            )
          : t(
              "Hide amounts and hours on both charts, including in the exported image. Bar shapes, dates, and labels stay visible. Data and scale do not change.",
              "Ukryj kwoty i godziny na obu wykresach — także na eksportowanym obrazie. Kształt słupków, daty i opisy zostają, dane i skala się nie zmieniają.",
            )
      }
      className="ui-button"
      style={{
        color: hidden ? "var(--text)" : "var(--muted)",
        fontSize: "var(--fs-3)",
        padding: "var(--s-2) var(--s-5)",
      }}
    >
      <span aria-hidden style={{ textDecoration: hidden ? "line-through" : "none" }}>123</span>
      {hidden ? t("values hidden", "liczby ukryte") : t("values visible", "liczby widoczne")}
    </button>
  );
}
