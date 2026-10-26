import { TableGrid, TableGridRow } from "./DataTable";
import type { RosterCard } from "../lib/roster";
import type { AccountCapabilities, GeminiWindow } from "../lib/api";
import { Card, CardTitle, EstimateTag, Eyebrow, KpiStrip, type KpiSpec } from "../components/ui";
import { compact, dayTime, duration, full, pct, relativeTime, usd } from "../lib/format";
import { getLocale, translate, useI18n } from "../lib/i18n";
import { polishPlural } from "../lib/mixFormat";
import { modelColors } from "../lib/model-colors";
import { MissingSection, missingVendorSections, vendorKpis, VENDOR_KPI_COLUMNS, type VendorOverviewSections } from "./VendorOverview";
export interface GeminiOverviewProps {
  card: RosterCard;
  pool: RosterCard[];
  onSelect: (id: string) => void;
  capabilities: AccountCapabilities | null;
}
function windowHours(kind: string): number {
  return kind === "five_hour" ? 5 : 168;
}
function windowLabel(kind: string): string {
  return kind === "five_hour" ? "5h" : kind === "weekly" ? "7d" : kind;
}
function localizedNumber(value: number, maximumFractionDigits = 0): string {
  return value.toLocaleString(getLocale(), { maximumFractionDigits });
}
function countLabel(
  n: number,
  enOne: string,
  enMany: string,
  plOne: string,
  plFew: string,
  plMany: string,
): string {
  return translate(Math.abs(n) === 1 ? enOne : enMany, polishPlural(n, plOne, plFew, plMany));
}
export function geminiSections({ card, pool, onSelect, capabilities }: GeminiOverviewProps): VendorOverviewSections {
  const t = translate;
  const g = card.gemini;
  if (!g) {
    return missingVendorSections(
      card.id + " " + t("- no /quota reading", "— brak odczytu /quota"),
      t(
        "The poller scans the pool about every 30 minutes. No reading means the first scan has not completed or the profile worker is unavailable.",
        "Poller przemiata pulę co około 30 minut. Brak odczytu oznacza, że pierwszy przemiat jeszcze nie doszedł albo worker profilu nie odpowiada."
      )
    );
  }
  // A withheld quota still leaves the locally indexed traffic; only its absence empties every section.
  if (!g.ok && !g.spend) {
    return missingVendorSections(
      card.id + " " + t("- worker unavailable", "— worker nie odpowiada"),
      (g.error ?? t("Unknown error.", "Nieznany błąd.")) +
        " " +
        t("The account has its own Windows profile and worker on port", "Konto ma własny profil Windows i własny worker na porcie") +
        " " +
        String(g.port ?? "?") +
        "; " +
        t("a dead worker is a profile problem, not a limit problem.", "martwy worker to problem profilu, nie limitu.")
    );
  }
  const geminiWindows = g.windows.filter((w) => /^gemini/i.test(w.limit_group));
  const otherWindows = g.windows.filter((w) => !/^gemini/i.test(w.limit_group));
  const binding =
    geminiWindows.length > 0
      ? geminiWindows.reduce((a, b) => (b.used_percent > a.used_percent ? b : a))
      : null;
  const collision = g.fingerprint_shared_with.length > 0;
  const reportsRemaining = capabilities?.reportsSide === "remaining";
  const sp = g.spend;
  const cacheRate = sp && sp.fresh_in + sp.cached_in > 0 ? (sp.cached_in / (sp.fresh_in + sp.cached_in)) * 100 : null;
  const maxModelTokens = Math.max(1, ...(sp?.models ?? []).map((m) => m.tokens));
  // Antigravity also serves Claude models, so each takes its own vendor's hue.
  const modelFills = modelColors((sp?.models ?? []).slice(0, 6).map((m) => m.model), "google");
  const kpis: KpiSpec[] = vendorKpis(
    {
      Remaining: {
        value: binding ? pct(binding.remaining_percent) : "—",
        note: binding ? `${windowLabel(binding.kind)} · ${t("used", "zużyte")} ${pct(binding.used_percent)}` : t("no Gemini row", "brak wiersza Gemini"),
        color:
          binding && binding.remaining_percent <= 0
            ? "var(--crit)"
            : binding && binding.remaining_percent <= 20
              ? "var(--warn)"
              : "var(--text)",
        title: t(
          "Remaining in the BINDING window - the one with less headroom, because it will refuse the next delegation first. The agy adapter rotates accounts by exactly this rule, so the card and router agree.",
          "Zapas WI\u0104\u017B\u0104CEGO okna \u2014 tego z mniejszym zapasem, bo ono odm\u00F3wi nast\u0119pnej delegacji jako pierwsze. Adapter agy rotuje konta dok\u0142adnie t\u0105 regu\u0142\u0105, wi\u0119c karta i router m\u00F3wi\u0105 to samo.",
        ) + (reportsRemaining ? t(
          " The vendor reports remaining capacity; the adjacent usage is its inverse.",
          " Vendor podaje w\u0142a\u015Bnie zapas; zu\u017Cycie obok jest jego odwr\u00F3ceniem.",
        ) : ""),
      },
      "Czas okna": {
        value: binding ? windowLabel(binding.kind) : "—",
        note: binding?.resets_at ? `${t("reset in", "reset za")} ${resetIn(binding.resets_at)}` : t("reset unknown", "reset nieznany"),
        title: t(
          "The vendor reports only the reset time, not the window start. This shows its length and time to reset, not “how much has elapsed out of what”.",
          "Vendor podaje tylko moment resetu, nie początek okna — dlatego stoi tu jego długość i czas do resetu, a nie „ile minęło z ilu”.",
        ),
      },
      ...(sp
        ? {
            "Koszt API-eq": {
              value: usd(sp.usd),
              note: t("our rate card valuation", "wycena naszym cennikiem"),
              color: "var(--text)",
              title: t(
                "Antigravity does not publish its own generation price (Grok does). This is our rate card applied to measured tokens - an estimate, not a vendor fact.",
                "Antigravity nie podaje własnej ceny generacji (grok podaje). To jest nasz cennik zastosowany do zmierzonych tokenów — oszacowanie, nie fakt od vendora.",
              ),
            },
            "Cache rate": {
              value: cacheRate != null ? pct(cacheRate, 1) : "—",
              note: `${compact(sp.fresh_in)} ${t("fresh input", "świeżego inputu")}`,
              color: "var(--violet)",
              title: t(
                "Share of cache in input. For this vendor, cache is separate from input, so the denominator is fresh input + cache. This differs from Codex and Grok.",
                "Udział cache w inpucie. U tego vendora cache jest ROZŁĄCZNY z inputem, więc mianownik to świeży input + cache — inaczej niż u Codeksa i groka.",
              ),
            },
          }
        : {
            "Koszt API-eq": {
              value: "—",
              note: t("profile unavailable", "profil niedostępny"),
              absent: true,
              title: t(
                "This account's conversation store is in another Windows profile and cannot be opened from this machine. This is an access limitation, not a vendor property, so the value is empty rather than zero.",
                "Magazyn rozmów tego konta leży w innym profilu Windows i nie da się go otworzyć z tej maszyny. To ograniczenie dostępu, nie właściwość vendora — dlatego pusto, a nie zero.",
              ),
            },
            "Cache rate": {
              value: "—",
              note: t("profile unavailable", "profil niedostępny"),
              absent: true,
              title: t(
                "Without access to the conversation store, there is no input from which to calculate cache share.",
                "Bez dostępu do magazynu rozmów nie ma z czego policzyć udziału cache.",
              ),
            },
          }),
    },
    [
      ...geminiWindows.map((w) => ({
        label: `${t("Window", "Okno")} ${windowLabel(w.kind)}`,
        value: pct(w.used_percent),
        note: w.resets_at ? `${t("reset in", "reset za")} ${resetIn(w.resets_at)}` : t("reset unknown", "reset nieznany"),
        color: w.used_percent >= 100 ? "var(--crit)" : "var(--text)",
        title: t(
          "The vendor reports HEADROOM: {0}. The displayed value is already inverted to usage.",
          `Vendor podaje ZAPAS: ${pct(w.remaining_percent)}. Pokazana liczba jest już odwrócona na zużycie.`, [pct(w.remaining_percent)],
        ),
      })),
      {
        label: t("Reading", "Odczyt"),
        value:
          g.age_minutes < 1
            ? t("now", "teraz")
            : g.age_minutes < 60
              ? `${localizedNumber(Math.round(g.age_minutes))} ${t("min", "min")}`
              : `${localizedNumber(g.age_minutes / 60, 1)} ${t("h", "h")}`,
        note: g.age_minutes > 90 ? t("scan is late", "przemiat się spóźnia") : t("ago", "temu"),
        color: g.age_minutes > 90 ? "var(--warn)" : "var(--text)",
        title: t(
          "Last successful /quota reading: {0}. One reading costs about 90 seconds of ConPTY, so scanning the whole pool takes minutes. It runs on its own slow clock.",
          `Ostatni udany odczyt /quota: ${relativeTime(g.ts)}. Jeden odczyt kosztuje ~90 s ConPTY, więc przemiat całej puli to minuty — dlatego chodzi na własnym, wolnym zegarze.`, [relativeTime(g.ts)],
        ),
      },
      {
        label: t("Profile", "Profil"),
        value: g.profile ?? "—",
        note: `${t("port", "port")} ${String(g.port ?? "?")}`,
        title: t(
          "Every pool account signs in officially in its OWN Windows profile. It is the only isolation that leaves the credential store untouched.",
          "Każde konto puli loguje się oficjalnie we WŁASNYM profilu Windows — to jedyna izolacja, która nie rusza magazynu poświadczeń.",
        ),
      },
      ...(sp
        ? [
            {
              label: t("Tokens in window", "Tokeny w oknie"),
              value: compact(sp.gross),
              note: `${compact(sp.fresh_in)} ${t("fresh", "świeżych")} · cache ${pct(cacheRate ?? 0, 0)}`,
              title: t(
                "{0} gross = fresh input + cache + output. For this vendor, cache is separate from input, so gross sums three components rather than two as with Codex and Grok.",
                `${full(sp.gross)} brutto = świeży input + cache + output. U tego vendora cache jest ROZŁĄCZNY z inputem, więc brutto sumuje trzy składniki, a nie dwa jak u Codeksa i groka.`, [full(sp.gross)],
              ),
            },
            {
              label: t("Generations", "Generacje"),
              value: full(sp.generations),
              note: `${full(sp.conversations)} ${t("conversations in window", "rozmów w oknie")}`,
              title: t(
                "Antigravity does not count API calls. The unit is a model generation. This is the closest equivalent to the 'calls' column for other vendors, but it is not the same.",
                "Antigravity nie liczy wywołań API — jednostką jest generacja modelu. To najbliższy odpowiednik kolumny 'calls' u pozostałych vendorów, ale nie to samo.",
              ),
            },
          ]
        : [
            {
              label: t("Tokens in window", "Tokeny w oknie"),
              value: "—",
              note: t("profile unavailable", "profil niedostępny"),
              absent: true,
              title: t(
                "This account's conversation store is in another Windows profile and cannot be opened from this machine. This is an access limitation, not a vendor property, so the value is empty rather than zero.",
                "Magazyn rozmów tego konta leży w innym profilu Windows i nie da się go otworzyć z tej maszyny. To ograniczenie dostępu, nie właściwość vendora — dlatego pusto, a nie zero.",
              ),
            },
          ]),
    ]
  );
  const collisionNote = collision ? (
    <Card>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <span style={{ width: 4, alignSelf: "stretch", borderRadius: "var(--r-bar)", background: "var(--crit)", flex: "0 0 4px" }} />
        <div>
          <div style={{ fontSize: "var(--fs-5)", fontWeight: 600, color: "var(--crit)" }}>
            {t("Fingerprint collision - this is not a separate account", "Kolizja odcisku palca — to nie jest osobne konto")}
          </div>
          <div style={{ fontSize: "var(--fs-4)", color: "var(--muted)", lineHeight: 1.55, marginTop: 3 }}>
            {t("Account ", "Konto ")}<b>{card.id}</b>{t(" has the same weekly reset time as ", " ma ten sam czas resetu tygodniowego co ")}<b>{g.fingerprint_shared_with.join(", ")}</b>.{" "}
            {t(
              "agy does not expose the account address programmatically, so the reset time is the only identity available. An identical time means one Google account under two handles. The headroom in these rows does not add up. The pool has less capacity than it appears, and two parallel builds compete for the same limit.",
              "agy nie udostępnia adresu konta programowo, więc czas resetu jest jedyną tożsamością, jaką mamy — a identyczny czas znaczy jedno konto Google pod dwoma uchwytami. Zapas tych wierszy nie sumuje się: pula ma mniej przepustowości, niż wygląda, a dwa równoległe buildy ścigają się o ten sam limit.",
            )}
          </div>
        </div>
      </div>
    </Card>
  ) : null;
  return {
    planWindows: (
      <>
        <KpiStrip items={kpis} columns={VENDOR_KPI_COLUMNS} />
        {!g.ok ? (
          <MissingSection
            title={card.id + " " + t("- no /quota reading", "— brak odczytu /quota")}
            detail={g.error ?? t("Unknown error.", "Nieznany błąd.")}
          />
        ) : <Card>
          <CardTitle
            title={`${t("Account limits", "Limity konta")} ${card.id}`}
            help={t("Two independent model families, each with its own weekly and five-hour window.", "Dwie niezależne rodziny modeli, każda z własnym oknem tygodniowym i 5-godzinnym.")}
            right={<EstimateTag title={t("This number comes directly from the vendor. It is measured, not calculated.", "Liczba pochodzi wprost od vendora — jest zmierzona, nie wyliczona.")}>{t("measured", "zmierzone")}</EstimateTag>}
          />
          <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 14 }}>
            <WindowGroup label={t("Gemini models", "Modele Gemini")} note={t("the Flash channel is here", "tu siedzi kanał Flash")} windows={geminiWindows} highlight={binding} />
            <WindowGroup
              label={t("Claude and GPT models", "Modele Claude i GPT")}
              note={t("separate allowance on the same account - it does not add to the one above", "osobny allowance na tym samym koncie — nie sumuje się z powyższym")}
              windows={otherWindows}
              highlight={null}
            />
          </div>
          <div className="mono" style={{ marginTop: 12, fontSize: "var(--fs-2)", color: "var(--faint)", lineHeight: 1.55 }}>
            {t("The vendor prints HEADROOM; bars show usage, or 100 - headroom. Fingerprint: ", "Vendor drukuje ZAPAS; paski pokazują zużycie, czyli 100 − zapas. Odcisk palca: ")}{g.fingerprint ?? "—"}
          </div>
        </Card>}
        <Card>
          <CardTitle
            title={t("Antigravity pool", "Pula Antigravity")}
            sub={`${localizedNumber(pool.length)} ${countLabel(pool.length, "account", "accounts", "konto", "konta", "kont")}`}
            help={t("Each account runs in its own Windows profile; the adapter rotates by the weaker of the two windows. Click an account to switch to it.", "Każde konto działa we własnym profilu Windows; adapter rotuje po słabszym z dwóch okien. Kliknij konto, aby się na nie przełączyć.")}
          />
          <div style={{ marginTop: 10, overflowX: "auto" }}>
            <TableGrid tableId="GeminiSections:pools"><div style={{ minWidth: 640 }}>
              <TableGridRow header className="mono" style={{ display: "grid", gridTemplateColumns: POOL_COLS, gap: 10, padding: "0 6px var(--s-3)", borderBottom: "1px solid var(--line2)", fontSize: "var(--fs-3)", color: "var(--muted)" }}>
                <span>{t("account", "konto")}</span><span style={{ textAlign: "right" }}>7d</span><span style={{ textAlign: "right" }}>5h</span>
                <span>{t("binding", "wiążące")}</span><span style={{ textAlign: "right" }}>{t("reset", "reset")}</span><span style={{ textAlign: "right" }}>{t("tokens", "tokeny")}</span>
                <span style={{ textAlign: "right" }}>{t("reading", "odczyt")}</span>
              </TableGridRow>
              {pool.map((c) => {
                const pg = c.gemini;
                const mine = (pg?.windows ?? []).filter((window) => /^gemini/i.test(window.limit_group));
                const weekly = mine.find((window) => window.kind === "weekly") ?? null;
                const fiveH = mine.find((window) => window.kind === "five_hour") ?? null;
                const bind = mine.length > 0 ? mine.reduce((a, b) => (b.used_percent > a.used_percent ? b : a)) : null;
                const shared = (pg?.fingerprint_shared_with ?? []).length > 0;
                return (
                  <TableGridRow as="button" key={c.id} onClick={() => onSelect(c.id)} className="hoverline" title={c.noteLong}
                    style={{ display: "grid", gridTemplateColumns: POOL_COLS, gap: 10, alignItems: "center", width: "100%", padding: "7px 6px", border: "none", borderBottom: "var(--rule)", background: c.id === card.id ? "var(--accent-soft)" : "transparent", cursor: "pointer", textAlign: "left", font: "inherit", color: "var(--text)" }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                      <span style={{ width: 7, height: 7, borderRadius: "var(--r-dot)", background: c.color, flex: "0 0 7px" }} />
                      <span className="mono" style={{ fontSize: "var(--fs-4)", fontWeight: c.id === card.id ? 600 : 400 }}>{c.id}</span>
                      {shared && <span className="mono" style={{ fontSize: "var(--fs-2)", color: "var(--crit)" }} title={c.noteLong}>{t("duplicate", "duplikat")}</span>}
                      {pg && !pg.ok && <span className="mono" style={{ fontSize: "var(--fs-2)", color: "var(--warn)" }}>{t("worker failed", "worker padł")}</span>}
                    </span>
                    <UsedCell w={weekly} /><UsedCell w={fiveH} />
                    <span className="mono" style={{ fontSize: "var(--fs-2)", color: "var(--muted)" }}>{bind ? windowLabel(bind.kind) + " · " + t("headroom", "zapas") + " " + pct(bind.remaining_percent) : "—"}</span>
                    <span className="mono" style={{ fontSize: "var(--fs-2)", textAlign: "right", color: "var(--faint)" }}>{bind?.resets_at ? resetIn(bind.resets_at) : "—"}</span>
                    <span className="mono" style={{ fontSize: "var(--fs-2)", fontFamily: "var(--font-figure)", letterSpacing: "-0.02em", textAlign: "right", color: pg?.spend ? "var(--muted)" : "var(--faint)" }}
                      title={pg?.spend
                        ? t("{0} gross in window · {1} API-equivalent", `${full(pg.spend.gross)} brutto w oknie · ${usd(pg.spend.usd)} API-eq`, [full(pg.spend.gross), usd(pg.spend.usd)])
                        : t("This account's conversation store is in an unavailable Windows profile.", "Magazyn rozmów tego konta jest w niedostępnym profilu Windows.")}>
                      {pg?.spend ? compact(pg.spend.gross) : t("no access", "brak dostępu")}
                    </span>
                    <span className="mono" style={{ fontSize: "var(--fs-2)", textAlign: "right", color: "var(--faint)" }}>{pg ? relativeTime(pg.ts) : "—"}</span>
                  </TableGridRow>
                );
              })}
            </div></TableGrid>
          </div>
          <div className="mono" style={{ marginTop: 8, fontSize: "var(--fs-2)", color: "var(--faint)", lineHeight: 1.55 }}>
            {t(
              "An empty 5h cell means “the vendor did not return this row”, not “the window is untouched”. An account without a 5h row is limited by the weekly window alone. Rotation uses the weaker of the two windows, because a fresh 5h window on an account with a burned weekly window buys no delegation.",
              "Puste 5h znaczy „vendor nie zwrócił tego wiersza”, nie „okno nietknięte” — konto bez wiersza 5h jest ograniczone samym tygodniem. Rotacja idzie po słabszym z dwóch okien, bo świeże okno 5h na koncie ze spalonym tygodniem nie kupuje ani jednej delegacji.",
            )}
          </div>
        </Card>
      </>
    ),
    models: sp && sp.models.length > 0 ? (
      <Card>
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          {sp.models.slice(0, 6).map((m, i) => (
            <div key={m.model} className="mono"
              style={{ display: "grid", gridTemplateColumns: "minmax(0,1.1fr) minmax(0,1fr) 52px 54px", gap: 8, alignItems: "center", fontSize: "var(--fs-3)" }}
              title={`${full(m.tokens)} ${t("gross", "brutto")} · ${m.generations} ${t("generations", "generacji")}`}>
              <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                <span style={{ width: 7, height: 7, borderRadius: "var(--r-bar)", background: modelFills[i], flex: "0 0 7px" }} />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.model}</span>
              </span>
              <span style={{ display: "block", height: 7, background: "var(--sunk)", border: "1px solid var(--line)", borderRadius: "var(--r-bar)", overflow: "hidden" }}>
                <span style={{ display: "block", height: "100%", width: `${(m.tokens / maxModelTokens) * 100}%`, background: modelFills[i] }} />
              </span>
              <span style={{ fontFamily: "var(--font-figure)", letterSpacing: "-0.02em", textAlign: "right", color: "var(--muted)" }}>{compact(m.tokens)}</span>
              <span style={{ fontFamily: "var(--font-figure)", letterSpacing: "-0.02em", textAlign: "right", color: "var(--text)" }}>{usd(m.usd)}</span>
            </div>
          ))}
        </div>
      </Card>
    ) : (
      <MissingSection
        title={t("No tokens for this profile", "Brak tokenów dla tego profilu")}
        detail={t(
          "The quota protobuf carries no tokens. The model breakdown can only be reconstructed from the conversation store in the Windows profile. This account's store is unavailable, so empty means “unknown”, not zero.",
          "Quota protobuf nie niesie tokenów. Rozbicie modeli da się odtworzyć wyłącznie z magazynu rozmów profilu Windows; dla tego konta magazyn jest niedostępny, więc brak oznacza „nie wiem”, nie zero.",
        )}
      />
    ),
    traffic: sp ? (
      <Card>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <SplitRow label={t("fresh input", "input świeży")} value={sp.fresh_in} total={sp.gross} color="var(--accent)" />
          <SplitRow label={t("cached input", "input z cache")} value={sp.cached_in} total={sp.gross} color="var(--violet)" />
          <SplitRow label={t("output", "output")} value={sp.out_total} total={sp.gross} color="var(--ok)" />
          <SplitRow label={t("including reasoning", "w tym myślenie")} value={sp.out_thinking} total={sp.gross} color="var(--warn)" />
        </div>
      </Card>
    ) : (
      <MissingSection
        title={t("No traffic breakdown", "Brak składu ruchu")}
        detail={t(
          "The /quota counter reports only window headroom. The input/cache/output breakdown comes from the conversation store in the profile, which this process cannot access.",
          "Licznik /quota podaje tylko zapas okien. Skład input/cache/output pochodzi z magazynu rozmów profilu, do którego ten proces nie ma dostępu.",
        )}
      />
    ),
    provenance: (
      <>
        {collisionNote}
        <Card>
          <CardTitle title={t("Where these numbers come from", "Skąd te liczby")} />
          <div className="mono" style={{ marginTop: 10, fontSize: "var(--fs-2)", color: "var(--muted)", lineHeight: 1.6 }}>
            {t("From protobuf in ", "Z protobufu w ")}<span style={{ color: "var(--faint)" }}>antigravity-cli/conversations/*.db</span>{t(", decoded ", ", rozebranego ")}
            <b>{t("without a schema", "bez schematu")}</b>{t(
              " - Google does not publish a .proto for this store. The field-to-meaning mapping is guarded by the invariant ",
              " — Google nie publikuje .proto dla tego magazynu. Przypisanie numerów pól do znaczeń pilnuje niezmiennika ",
            )}<span style={{ color: "var(--text)" }}>{t("output = reasoning + response", "output = myślenie + odpowiedź")}</span>{t(
              "; breaking it stops ingest instead of putting numbers into the database that no longer mean what they used to.",
              "; jego złamanie zatrzymuje ingest, zamiast wpuścić do bazy liczby, które przestały znaczyć to, co znaczyły.",
            )}
          </div>
          <div className="mono" style={{ marginTop: 8, fontSize: "var(--fs-2)", color: "var(--muted)", lineHeight: 1.6 }}>
            {t("Time is resolved per ", "Czas ma rozdzielczość ")}<b>{t("conversation", "rozmowy")}</b>{t(
              ", not generation",
              ", nie generacji",
            )}{sp ? ` (${sp.resolution})` : ""}{t(
              " - a conversation crossing reset is assigned wholly to one side of the window. The window is ",
              " — rozmowa przecinająca reset wpada w całości po jednej stronie okna. Okno jest ",
            )}{sp ? (sp.anchored ? t("anchored by the reset from the gauge", "zakotwiczone resetem z gauge'a") : t("rolling (the gauge has not answered yet)", "kroczące (gauge jeszcze nie odpowiedział)")) : t("unknown", "nieznane")}.
          </div>
          <div className="mono" style={{ marginTop: 8, fontSize: "var(--fs-2)", color: "var(--faint)", lineHeight: 1.6 }}>
            {t("Full indexed range: ", "Cały zindeksowany zakres: ")}{sp?.first_ts ? dayTime(sp.first_ts) : "—"} → {sp?.last_ts ? dayTime(sp.last_ts) : "—"} ·{" "}
            {sp ? compact(sp.all_time_gross) : "—"} {t("gross", "brutto")} · {sp ? usd(sp.all_time_usd) : "—"} {t("API-equivalent", "API-eq")}
          </div>
        </Card>
      </>
    ),
    subs: {
      models: sp && sp.models.length > 0 ? t("tokens reconstructed from the Antigravity store", "tokeny odtworzone z magazynu Antigravity") : undefined,
      traffic: sp ? t("cache is separate from input", "cache jest rozłączny z inputem") : undefined,
    },
    calibration: (
      <MissingSection
        title={t("No $ / point calibration", "Kalibracja $ / punkt nie występuje")}
        detail={reportsRemaining
          ? t(
              "Antigravity reports headroom without a denominator. The adapter inverts it to usage, but does not guess the value of the full window or the $ / point rate.",
              "Antigravity raportuje zapas bez mianownika. Adapter odwraca go na zużycie, ale nie zgaduje wartości całego okna ani kursu $ / punkt.",
            )
          : t(
              "The backend did not declare a reported-percentage side, so there is no honest basis for $ / point calibration.",
              "Backend nie zadeklarował strony raportowanego procentu; nie ma uczciwej podstawy do kalibracji $ / punkt.",
            )}
      />
    ),
  };
}
const POOL_COLS = "minmax(130px,1.1fr) 58px 58px minmax(110px,1fr) 74px 70px 86px";
function UsedCell({ w }: { w: GeminiWindow | null }) {
  const { t } = useI18n();
  if (!w) {
    return (
      <span
        className="mono"
        style={{ fontSize: "var(--fs-3)", textAlign: "right", color: "var(--faint)" }}
        title={t(
          "The vendor did not include this window in the reading. The window exists, verified on account 2026-08-24, so this means “unknown”, not “absent”.",
          "Vendor nie wydrukował tego okna w tym odczycie. Okno istnieje — sprawdzone na koncie 2026-08-24 — więc to jest „nie wiem”, nie „nie ma”.",
        )}
      >
        —
      </span>
    );
  }
  return (
    <span
      className="mono"
      style={{
        fontSize: "var(--fs-4)",
        fontWeight: 500,
        fontFamily: "var(--font-figure)",
        letterSpacing: "-0.02em",
        textAlign: "right",
        color: w.used_percent >= 100 ? "var(--crit)" : w.used_percent >= 80 ? "var(--warn)" : "var(--text)",
      }}
      title={t("The vendor reports headroom {0}", `Vendor podaje zapas ${pct(w.remaining_percent)}`, [pct(w.remaining_percent)])}
    >
      {pct(w.used_percent)}
    </span>
  );
}
function WindowGroup({
  label,
  note,
  windows,
  highlight,
}: {
  label: string;
  note: string;
  windows: GeminiWindow[];
  highlight: GeminiWindow | null;
}) {
  const { t } = useI18n();
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
        <Eyebrow>{label}</Eyebrow>
        <span className="mono" style={{ fontSize: "var(--fs-2)", color: "var(--faint)" }}>
          {note}
        </span>
      </div>
      <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 8 }}>
        {windows.length === 0 && (
          <span className="mono" style={{ fontSize: "var(--fs-3)", color: "var(--faint)" }}>
            {t("The vendor returned no rows for this family.", "Vendor nie zwrócił wierszy dla tej rodziny.")}
          </span>
        )}
        {windows.length > 0 && !windows.some((w) => w.kind === "five_hour") && (
          <span className="mono" style={{ fontSize: "var(--fs-3)", color: "var(--faint)" }}>
            {t("Window 5h · the vendor did not include it in this reading (it exists, but has no value)", "okno 5h · vendor nie wydrukował go w tym odczycie (istnieje, ale nie ma liczby)")}
          </span>
        )}
        {windows.map((w) => {
          const isBinding = highlight != null && highlight.kind === w.kind;
          return (
            <div key={w.kind}>
              <div className="mono" style={{ display: "flex", justifyContent: "space-between", fontSize: "var(--fs-3)", marginBottom: 3 }}>
                <span style={{ color: "var(--muted)" }}>
                  {t("window", "okno")} {windowLabel(w.kind)}
                  {isBinding && <span style={{ color: "var(--warn)" }}> · {t("binding", "wiążące")}</span>}
                </span>
                <span style={{ color: "var(--muted)" }}>
                  <b style={{ color: "var(--text)" }}>{pct(w.used_percent)}</b> {t("used", "zużyte")} · {t("headroom", "zapas")} {pct(w.remaining_percent)}
                  {w.resets_at && ` · ${t("reset in", "reset za")} ${resetIn(w.resets_at)}`}
                </span>
              </div>
              <div
                style={{
                  position: "relative",
                  height: isBinding ? 14 : 10,
                  background: "var(--sunk)",
                  border: `1px solid ${isBinding ? "color-mix(in oklab, var(--warn) 40%, var(--line))" : "var(--line)"}`,
                  borderRadius: "var(--r-bar)",
                  overflow: "hidden",
                }}
                title={t(
                  "Vendor headroom: {0}. Inverted to usage: {1}.",
                  `Vendor: zapas ${pct(w.remaining_percent)}. Odwrócone na zużycie: ${pct(w.used_percent)}.`, [pct(w.remaining_percent), pct(w.used_percent)],
                )}
              >
                <div
                  style={{
                    position: "absolute",
                    inset: `0 ${100 - Math.min(100, w.used_percent)}% 0 0`,
                    background:
                      w.used_percent >= 100 ? "var(--crit)" : w.used_percent >= 80 ? "var(--warn)" : "var(--gemini)",
                  }}
                />
                {w.resets_at && <ElapsedTick resetsAt={w.resets_at} hours={windowHours(w.kind)} />}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
function ElapsedTick({ resetsAt, hours }: { resetsAt: string; hours: number }) {
  const { t } = useI18n();
  const resetMs = new Date(resetsAt).getTime();
  if (!Number.isFinite(resetMs)) return null;
  const winMs = hours * 3_600_000;
  const elapsed = Math.max(0, Math.min(100, ((Date.now() - (resetMs - winMs)) / winMs) * 100));
  return (
    <div
      title={t("{0} of the window elapsed", `${pct(elapsed)} okna minęło`, [pct(elapsed)])}
      style={{ position: "absolute", top: 0, bottom: 0, left: `${elapsed}%`, width: 2, background: "var(--text)" }}
    />
  );
}
function SplitRow({ label, value, total, color }: { label: string; value: number; total: number; color: string }) {
  const { t } = useI18n();
  const share = total > 0 ? (value / total) * 100 : 0;
  return (
    <div>
      <div className="mono" style={{ display: "flex", justifyContent: "space-between", fontSize: "var(--fs-3)", marginBottom: 3 }}>
        <span style={{ color: "var(--muted)" }}>{label}</span>
        <span style={{ color: "var(--muted)" }} title={`${full(value)} ${t("tokens", "tokenów")}`}>
          <b style={{ color: "var(--text)" }}>{compact(value)}</b> · {pct(share, 1)}
        </span>
      </div>
      <div style={{ height: 8, background: "var(--sunk)", border: "1px solid var(--line)", borderRadius: "var(--r-bar)", overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${share}%`, background: color }} />
      </div>
    </div>
  );
}
function resetIn(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return "—";
  return ms <= 0 ? translate("now", "teraz") : duration(ms / 3_600_000);
}
