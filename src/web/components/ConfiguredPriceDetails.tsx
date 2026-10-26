import type { ReactNode } from "react";
import type { CodexAccountingRule, CodexTokenRates, TimelinePriceTransition } from "../../shared/codex-accounting";
import { useI18n } from "../lib/i18n";
import { TableRow, Table, Td, Th } from "./ui";

type RateKey = keyof CodexTokenRates;
const RATE_KEYS: RateKey[] = ["in_uncached", "in_cache_read", "out_total"];

function safeUrlLabel(source: string): string {
  try {
    const url = new URL(source);
    return `${url.hostname}${url.pathname}`;
  } catch {
    return source;
  }
}

export function ConfiguredPriceDetails({ pricing }: { pricing: TimelinePriceTransition[] }) {
  const { t, locale } = useI18n();
  const number = (value: number | null | undefined): string => {
    if (value == null || !Number.isFinite(value)) return t("missing", "brak");
    return value.toLocaleString(locale, { maximumFractionDigits: 6 });
  };
  const vector = (rule: CodexAccountingRule | null, effective = false): string => {
    if (!rule) return t("not configured", "nie skonfigurowano");
    return RATE_KEYS.map((key) => {
      const value = rule.rates?.[key];
      if (value == null || !Number.isFinite(value)) return t("missing", "brak");
      return number(effective ? value * rule.multiplier : value);
    }).join(" / ");
  };
  const transition = (before: CodexAccountingRule | null, after: CodexAccountingRule | null, render: (rule: CodexAccountingRule | null) => string = rule => vector(rule)) => (
    <>{render(before)} → {render(after)}</>
  );
  const multiplier = (rule: CodexAccountingRule | null): string => rule && Number.isFinite(rule.multiplier)
    ? `×${number(rule.multiplier)}`
    : t("not configured", "nie skonfigurowano");
  const confidence = (rule: CodexAccountingRule | null): string => {
    if (!rule) return t("not configured", "nie skonfigurowano");
    return rule.confidence === "official"
      ? t("official", "oficjalne")
      : t("user declaration", "deklaracja użytkownika");
  };
  const evidence = (rule: CodexAccountingRule | null): ReactNode => {
    if (!rule) return <span>{t("not configured", "nie skonfigurowano")}</span>;
    return <span>
      <span>{confidence(rule)}</span>
      {rule.sources.map((source, index) => <span key={source}>{index === 0 ? " · " : " · "}<a href={source} target="_blank" rel="noreferrer">{safeUrlLabel(source)}</a></span>)}
    </span>;
  };
  const includedUsage = (rule: CodexAccountingRule | null): string => {
    const value = rule?.included_usage ?? "unknown";
    if (value === "proportional") return t("declaration: proportional", "deklaracja: proporcjonalnie");
    if (value === "unchanged") return t("declaration: unchanged", "deklaracja: bez zmiany");
    return t("declaration: unknown", "deklaracja: nieznana");
  };
  const longContext = (rule: CodexAccountingRule | null): string => {
    if (!rule?.long_context) return t("none", "brak");
    return `${t("above", "powyżej")} ${number(rule.long_context.above_input_tokens)} ${t("input tokens", "tokenów wejścia")}: ${vector({ ...rule, rates: rule.long_context.rates }, true)}`;
  };

  if (pricing.length === 0) return null;
  return <div>
    <p className="codex-view-description">
      {t("Configured application pricing: effective rates per 1M tokens, shown as fresh input / cache read / output. Zero is a configured rate; missing is not free.", "Skonfigurowany cennik aplikacji: obowiązujące stawki za 1 mln tokenów, w kolejności świeże wejście / cache read / wyjście. Zero jest skonfigurowaną stawką; brak nie oznacza darmowego ruchu.")}
    </p>
    <Table tableId="ConfiguredPriceDetails:0">
      <thead><TableRow header>
        <Th columnId="c0">{t("Model", "Model")}</Th>
        <Th columnId="c1">{t("Basis / speed", "Podstawa / tryb")}</Th>
        <Th columnId="c2" title={t("Effective rates per million tokens: fresh input / cache read / output, before and after.", "Obowiązujące stawki za milion tokenów: świeże wejście / cache read / wyjście, przed i po.")}>{t("Effective rates / 1M · before → after", "Stawki / 1M · przed → po")}</Th>
        <Th columnId="c3">{t("Multiplier · before → after", "Mnożnik · przed → po")}</Th>
        <Th columnId="c4" title={t("Separate long-context threshold and rates.", "Osobny próg i stawki długiego kontekstu.")}>{t("Long context", "Długi kontekst")}</Th>
        <Th columnId="c5">{t("After included usage", "Zużycie po zmianie")}</Th>
        <Th columnId="c6">{t("Evidence", "Dowód")}</Th>
      </TableRow></thead>
      <tbody>{pricing.map((item, index) => <TableRow key={`${item.model}:${item.basis}:${item.speed}:${index}`}>
        <Td>{item.model}</Td>
        <Td>{item.basis === "chatgpt_credits" ? t("ChatGPT credits", "kredyty ChatGPT") : t("API equivalent USD", "ekwiwalent API USD")} · {item.speed === "fast" ? t("Fast", "Fast") : t("Standard", "Standard")}</Td>
        <Td mono title={t("fresh input / cache read / output", "świeże wejście / cache read / wyjście")}>
          {transition(item.before, item.after, rule => vector(rule, true))}
        </Td>
        <Td mono>{transition(item.before, item.after, multiplier)}</Td>
        <Td style={{ whiteSpace: "normal", minWidth: 180 }}>{transition(item.before, item.after, longContext)}</Td>
        <Td style={{ whiteSpace: "normal" }}>{includedUsage(item.after)}</Td>
        <Td style={{ whiteSpace: "normal", minWidth: 220 }}>
          <div>{t("before", "przed")}: {evidence(item.before)}</div>
          <div>{t("after", "po")}: {evidence(item.after)}</div>
        </Td>
      </TableRow>)}</tbody>
    </Table>
    <p className="codex-view-description">
      {t("The after included-usage value is a declaration about how this rate is treated. It does not multiply the gauge, and a user declaration does not establish a fixed subscription credit budget behind the percentage meter.", "Wartość zużycia po zmianie jest deklaracją sposobu traktowania tej stawki. Nie mnoży licznika gauge, a deklaracja użytkownika nie ustanawia stałego budżetu kredytów abonamentu ukrytego za procentem.")}
    </p>
  </div>;
}
