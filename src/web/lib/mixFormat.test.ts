import { describe, expect, it } from "bun:test";
import type {
  CalendarGranularity,
  CapacityEquivalents,
  Equivalent,
  EquivalentAbsentReason,
  ProjectCostCoverage,
  ProjectCostResponse,
  Provenance,
  RepoBucketPoint,
  RepoHistoryResponse,
  SeatTime,
  SubjectCost,
  SubjectSubscriptionSlice,
  SubscriptionSpend,
} from "./api";
import { EQUIVALENT_ABSENT_REASONS } from "./api";
import type {
  ProjectCostCoverage as ServerProjectCostCoverage,
  ProjectCostResponse as ServerProjectCostResponse,
  SubjectCost as ServerSubjectCost,
  SubjectSubscriptionSlice as ServerSubjectSubscriptionSlice,
  SubscriptionSpend as ServerSubscriptionSpend,
} from "../../server/project-cost";
import type {
  Granularity as ServerGranularity,
  RepoBucket as ServerRepoBucket,
  RepoHistory as ServerRepoHistory,
} from "../../server/repo-history";
import {
  computeEquivalentsAndProvenance,
  type CapacityEquivalents as ServerCapacityEquivalents,
  type Equivalent as ServerEquivalent,
  type Provenance as ServerProvenance,
  type SeatTime as ServerSeatTime,
  type SubscriptionCapacity,
} from "../../server/capacity-equivalents";
import {
  BRAK_KALIBRACJI,
  calibrationSummary,
  utilisationVerdict,
  calendarGranularityLabel,
  capacityAxisLabel,
  cadenceAxisLabel,
  formatCapacityEquivalent,
  formatEquivalentsLine,
  formatMoney,
  formatMoneyLabeled,
  formatQty,
  formatSeatTime,
  MONEY_HINT,
  MONEY_LABEL,
  polishPlural,
  priceAxisLabel,
  provenanceAxesLine,
  provenanceLacksCalibration,
} from "./mixFormat";
import { setLanguage } from "./i18n";

function withLanguage(language: "en" | "pl", assertions: () => void): void {
  try {
    setLanguage(language);
    assertions();
  } finally {
    setLanguage("en");
  }
}

const SESJA = ["sesja", "sesje", "sesji"] as const;
const TYDZIEN = ["tydzień", "tygodnie", "tygodni"] as const;
const MIESIAC = ["miesiąc", "miesiące", "miesięcy"] as const;
function present(value: number): Equivalent {
  return { value, absent: null };
}
function absent(reason: EquivalentAbsentReason): Equivalent {
  return { value: null, absent: reason };
}
const covered: Provenance = {
  capacity: "measured",
  price: "rate-card",
  cadence: "declared",
  calibration_covers_period: true,
  coverage: "full",
  measured_share: 1,
};
const uncovered: Provenance = {
  capacity: "measured",
  price: "rate-card",
  cadence: "declared",
  calibration_covers_period: false,
  coverage: "none",
  measured_share: 0,
};
const noneCap: Provenance = {
  capacity: "none",
  price: "none",
  cadence: "none",
  calibration_covers_period: false,
  coverage: "none",
  measured_share: 0,
};
type MutualExtends<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _sliceParity: MutualExtends<SubjectSubscriptionSlice, ServerSubjectSubscriptionSlice> = true;
const _subjectParity: MutualExtends<SubjectCost, ServerSubjectCost> = true;
const _spendParity: MutualExtends<SubscriptionSpend, ServerSubscriptionSpend> = true;
const _coverageParity: MutualExtends<ProjectCostCoverage, ServerProjectCostCoverage> = true;
const _costParity: MutualExtends<ProjectCostResponse, ServerProjectCostResponse> = true;
const _historyParity: MutualExtends<RepoHistoryResponse, ServerRepoHistory> = true;
const _bucketParity: MutualExtends<RepoBucketPoint, ServerRepoBucket> = true;
const _granularityParity: MutualExtends<CalendarGranularity, ServerGranularity> = true;
const _equivalentsParity: MutualExtends<CapacityEquivalents, ServerCapacityEquivalents> = true;
const _equivalentParity: MutualExtends<Equivalent, ServerEquivalent> = true;
const _provenanceParity: MutualExtends<Provenance, ServerProvenance> = true;
const _seatParity: MutualExtends<SeatTime, ServerSeatTime> = true;
void _sliceParity;
void _subjectParity;
void _spendParity;
void _coverageParity;
void _costParity;
void _historyParity;
void _bucketParity;
void _granularityParity;
void _equivalentsParity;
void _equivalentParity;
void _provenanceParity;
void _seatParity;
describe("polishPlural", () => {
  it("uses 1 / 2–4 / 5+ forms, including 12 vs 22", () => {
    expect(polishPlural(1, ...SESJA)).toBe("sesja");
    expect(polishPlural(2, ...SESJA)).toBe("sesje");
    expect(polishPlural(3, ...SESJA)).toBe("sesje");
    expect(polishPlural(4, ...SESJA)).toBe("sesje");
    expect(polishPlural(5, ...SESJA)).toBe("sesji");
    expect(polishPlural(0, ...SESJA)).toBe("sesji");
    expect(polishPlural(12, ...SESJA)).toBe("sesji");
    expect(polishPlural(22, ...SESJA)).toBe("sesje");
    expect(polishPlural(21, ...SESJA)).toBe("sesji");
    expect(polishPlural(1, ...TYDZIEN)).toBe("tydzień");
    expect(polishPlural(2, ...TYDZIEN)).toBe("tygodnie");
    expect(polishPlural(5, ...TYDZIEN)).toBe("tygodni");
    expect(polishPlural(1, ...MIESIAC)).toBe("miesiąc");
    expect(polishPlural(2, ...MIESIAC)).toBe("miesiące");
    expect(polishPlural(5, ...MIESIAC)).toBe("miesięcy");
  });
  it("sends non-integers to the 5+ form (1.4, 10.2)", () => {
    expect(polishPlural(1.4, ...SESJA)).toBe("sesji");
    expect(polishPlural(10.2, ...SESJA)).toBe("sesji");
    expect(polishPlural(1.4, ...TYDZIEN)).toBe("tygodni");
    expect(polishPlural(2.5, ...MIESIAC)).toBe("miesięcy");
  });
});
describe("formatQty rounding", () => {
  it("keeps one decimal and drops trailing zeros", () => {
    expect(formatQty(10.2)).toBe("10.2");
    expect(formatQty(1.4)).toBe("1.4");
    expect(formatQty(1.0)).toBe("1");
    expect(formatQty(0)).toBe("0");
    expect(formatQty(2.1743)).toBe("2.2");
    expect(formatQty(0.095)).toBe("0.1");
    expect(formatQty(-0)).toBe("0");
  });
});
describe("money billed vs API-counterfactual", () => {
  it("labels billed as fact and api as counterfactual, reusing $ formatting", () => {
    expect(formatMoney(4.09)).toBe("$4.09");
    expect(formatMoney(null)).toBe("—");
    expect(formatMoney(undefined)).toBe("—");
    withLanguage("en", () => {
      expect(formatMoneyLabeled(4.09, "billed")).toBe("$4.09 · allocated share of declared plan cost");
      expect(formatMoneyLabeled(948.98, "api")).toBe("$948.98 · API list price");
      expect(MONEY_LABEL.billed).toBe("allocated share of declared plan cost");
      expect(MONEY_HINT.billed).toContain("stored billing cycles");
      expect(MONEY_HINT.billed).toContain("dated catalog price");
      expect(MONEY_HINT.billed).toContain("not an invoice or proof of payment");
      expect(MONEY_HINT.billed).not.toContain("actually paid");
      expect(MONEY_LABEL.api).toBe("API list price");
    });
    withLanguage("pl", () => {
      expect(formatMoneyLabeled(4.09, "billed")).toBe(
        "$4,09 · przypisany udział w deklarowanym, proporcjonalnym koszcie planów",
      );
      expect(formatMoneyLabeled(948.98, "api")).toBe("$948,98 · cennik API");
      expect(MONEY_LABEL.billed).toBe("przypisany udział w deklarowanym, proporcjonalnym koszcie planów");
      expect(MONEY_HINT.billed).toContain("zapisanych cykli");
      expect(MONEY_HINT.billed).toContain("datowana cena katalogowa");
      expect(MONEY_HINT.billed).toContain("nie jest faktura ani dowód zapłaty");
      expect(MONEY_HINT.billed).not.toContain("faktycznie zapłaconym");
      expect(MONEY_LABEL.api).toBe("cennik API");
    });
  });
});
describe("formatSeatTime", () => {
  it("renders subscription seat time in the active locale", () => {
    const seat: SeatTime = { months: 1.4, weeks: 6.0877 };
    withLanguage("en", () => {
      expect(formatSeatTime(seat)).toBe("1.4 mo. / 6.1 wk. of subscription");
    });
    withLanguage("pl", () => {
      expect(formatSeatTime(seat)).toBe("1,4 mies. / 6,1 tyg. abonamentu");
    });
  });
  it("renders real zero seat-time as 0, not no calibration", () => {
    withLanguage("en", () => {
      expect(formatSeatTime({ months: 0, weeks: 0 })).toBe("0 mo. / 0 wk. of subscription");
    });
    withLanguage("pl", () => {
      expect(formatSeatTime({ months: 0, weeks: 0 })).toBe("0 mies. / 0 tyg. abonamentu");
    });
  });
  it("renders missing declared price as em dash, never 0", () => {
    expect(formatSeatTime(null)).toBe("—");
    expect(formatSeatTime(undefined)).toBe("—");
    expect(formatSeatTime(null)).not.toMatch(/0/);
  });
});
describe("formatCapacityEquivalent", () => {
  it("prefixes present estimates in English and retains Polish plurals", () => {
    withLanguage("en", () => {
      expect(formatCapacityEquivalent(present(10.2), "session")).toBe("≈ 10.2 sessions");
      expect(formatCapacityEquivalent(present(1), "session")).toBe("≈ 1 session");
      expect(formatCapacityEquivalent(present(2), "session")).toBe("≈ 2 sessions");
      expect(formatCapacityEquivalent(present(5), "session")).toBe("≈ 5 sessions");
      expect(formatCapacityEquivalent(present(1), "weekly")).toBe("≈ 1 week");
      expect(formatCapacityEquivalent(present(2), "weekly")).toBe("≈ 2 weeks");
      expect(formatCapacityEquivalent(present(5), "weekly")).toBe("≈ 5 weeks");
      expect(formatCapacityEquivalent(present(1.4), "weekly")).toBe("≈ 1.4 weeks");
    });
    withLanguage("pl", () => {
      expect(formatCapacityEquivalent(present(10.2), "session")).toBe("≈ 10,2 sesji");
      expect(formatCapacityEquivalent(present(1), "session")).toBe("≈ 1 sesja");
      expect(formatCapacityEquivalent(present(2), "session")).toBe("≈ 2 sesje");
      expect(formatCapacityEquivalent(present(5), "session")).toBe("≈ 5 sesji");
      expect(formatCapacityEquivalent(present(1), "weekly")).toBe("≈ 1 tydzień");
      expect(formatCapacityEquivalent(present(2), "weekly")).toBe("≈ 2 tygodnie");
      expect(formatCapacityEquivalent(present(5), "weekly")).toBe("≈ 5 tygodni");
      expect(formatCapacityEquivalent(present(1.4), "weekly")).toBe("≈ 1,4 tygodni");
    });
  });
  it("renders a calibrated zero as ≈ 0, not as no calibration", () => {
    withLanguage("en", () => {
      expect(formatCapacityEquivalent(present(0), "session")).toBe("≈ 0 sessions");
      expect(formatCapacityEquivalent(present(0), "weekly")).toBe("≈ 0 weeks");
    });
    withLanguage("pl", () => {
      expect(formatCapacityEquivalent(present(0), "session")).toBe("≈ 0 sesji");
      expect(formatCapacityEquivalent(present(0), "weekly")).toBe("≈ 0 tygodni");
    });
  });
  it("renders every absent reason as no calibration and never a digit", () => {
    withLanguage("en", () => {
      for (const reason of EQUIVALENT_ABSENT_REASONS) {
        const text = formatCapacityEquivalent(absent(reason), "session");
        expect(text).toBe("no calibration");
        expect(text).not.toMatch(/\d/);
        expect(text).not.toBe("0");
      }
      expect(formatCapacityEquivalent(null, "session")).toBe("no calibration");
      expect(formatCapacityEquivalent(undefined, "weekly")).toBe("no calibration");
      expect(formatCapacityEquivalent({ value: Number.NaN, absent: null }, "session")).toBe("no calibration");
    });
    withLanguage("pl", () => {
      for (const reason of EQUIVALENT_ABSENT_REASONS) {
        const text = formatCapacityEquivalent(absent(reason), "session");
        expect(text).toBe(BRAK_KALIBRACJI);
        expect(text).not.toMatch(/\d/);
        expect(text).not.toBe("0");
      }
      expect(formatCapacityEquivalent(null, "session")).toBe(BRAK_KALIBRACJI);
      expect(formatCapacityEquivalent(undefined, "weekly")).toBe(BRAK_KALIBRACJI);
      expect(formatCapacityEquivalent({ value: Number.NaN, absent: null }, "session")).toBe(BRAK_KALIBRACJI);
    });
  });
});
describe("formatEquivalentsLine", () => {
  it("joins independent estimates in the active locale and appends the plan once", () => {
    const eq: CapacityEquivalents = {
      full_5h_sessions: present(10.2),
      weekly_cycles: present(0.5),
      monthly_subscriptions: present(0.11),
    };
    withLanguage("en", () => {
      expect(formatEquivalentsLine(eq, "claude max-20x")).toBe("≈ 10.2 sessions · ≈ 0.5 weeks claude max-20x");
    });
    withLanguage("pl", () => {
      expect(formatEquivalentsLine(eq, "claude max-20x")).toBe("≈ 10,2 sesji · ≈ 0,5 tygodni claude max-20x");
    });
  });
  it("keeps no calibration in the missing slot when only one estimate is present", () => {
    withLanguage("en", () => {
      const sessionsPresent = formatEquivalentsLine({
        full_5h_sessions: present(1),
        weekly_cycles: absent("cadence_uncalibrated"),
        monthly_subscriptions: absent("cadence_uncalibrated"),
      });
      const weeklyPresent = formatEquivalentsLine({
        full_5h_sessions: absent("cadence_uncalibrated"),
        weekly_cycles: present(0.5),
        monthly_subscriptions: present(0.11),
      });
      expect(sessionsPresent).toBe("≈ 1 session · no calibration");
      expect(sessionsPresent).toContain("no calibration");
      expect(sessionsPresent).not.toBe("≈ 1 session");
      expect(weeklyPresent).toBe("no calibration · ≈ 0.5 weeks");
      expect(weeklyPresent).toContain("no calibration");
      expect(weeklyPresent).not.toBe("≈ 0.5 weeks");
    });
    withLanguage("pl", () => {
      const sessionsPresentPl = formatEquivalentsLine({
        full_5h_sessions: present(1),
        weekly_cycles: absent("cadence_uncalibrated"),
        monthly_subscriptions: absent("cadence_uncalibrated"),
      });
      expect(sessionsPresentPl).toBe("≈ 1 sesja · brak kalibracji");
      expect(sessionsPresentPl).toContain(BRAK_KALIBRACJI);
      expect(sessionsPresentPl).not.toBe("≈ 1 sesja");
      const weeklyPresentPl = formatEquivalentsLine({
        full_5h_sessions: absent("cadence_uncalibrated"),
        weekly_cycles: present(0.5),
        monthly_subscriptions: present(0.11),
      });
      expect(weeklyPresentPl).toBe("brak kalibracji · ≈ 0,5 tygodni");
      expect(weeklyPresentPl).toContain(BRAK_KALIBRACJI);
      expect(weeklyPresentPl).not.toBe("≈ 0,5 tygodni");
    });
  });
  it("collapses both-absent to one no calibration, never 0", () => {
    withLanguage("en", () => {
      expect(
        formatEquivalentsLine({
          full_5h_sessions: absent("period_uncovered"),
          weekly_cycles: absent("period_uncovered"),
          monthly_subscriptions: absent("period_uncovered"),
        }),
      ).toBe("no calibration");
      expect(formatEquivalentsLine(null)).toBe("no calibration");
      expect(formatEquivalentsLine(null)).not.toMatch(/0/);
    });
    withLanguage("pl", () => {
      expect(
        formatEquivalentsLine({
          full_5h_sessions: absent("period_uncovered"),
          weekly_cycles: absent("period_uncovered"),
          monthly_subscriptions: absent("period_uncovered"),
        }),
      ).toBe(BRAK_KALIBRACJI);
      expect(formatEquivalentsLine(null)).toBe(BRAK_KALIBRACJI);
      expect(formatEquivalentsLine(null)).not.toMatch(/0/);
    });
  });
  it("formats the producer mixed-absent shape (5h cadence_uncalibrated, weekly present)", () => {
    const claudeWeeklyOnly: SubscriptionCapacity = {
      sub_id: "claude",
      vendor: "claude",
      plan: "max-20x",
      usd_per_month: 200,
      usd_per_point: 2.406,
      weekly_window_value_usd: 240.6,
      session_window_value_usd: null,
      window_hours: 168,
      session_hours: null,
      capacity_basis: "single",
      price_basis: "rate-card",
      cadence: "declared",
      calibration_start_ts: "2026-08-01",
      calibration_end_ts: "2026-08-31",
    };
    const produced = computeEquivalentsAndProvenance(120.3, claudeWeeklyOnly, {
      since: "2026-08-05",
      until: "2026-08-20",
    });
    const webEq: CapacityEquivalents = produced.equivalents;
    expect(webEq.full_5h_sessions).toEqual({ value: null, absent: "cadence_uncalibrated" });
    expect(webEq.weekly_cycles).toEqual({ value: 0.5, absent: null });
    expect(produced.provenance.calibration_covers_period).toBe(true);
    expect(produced.provenance.capacity).toBe("single");
    expect(provenanceLacksCalibration(produced.provenance)).toBe(false);
    withLanguage("en", () => {
      const weeklyOnly = formatCapacityEquivalent(webEq.weekly_cycles, "weekly");
      const line = formatEquivalentsLine(webEq);
      expect(weeklyOnly).toBe("≈ 0.5 weeks");
      expect(line).toBe("no calibration · ≈ 0.5 weeks");
      expect(line).toContain("no calibration");
      expect(line).toContain(weeklyOnly);
      expect(line).not.toBe(weeklyOnly);
    });
    withLanguage("pl", () => {
      const weeklyOnly = formatCapacityEquivalent(webEq.weekly_cycles, "weekly");
      const line = formatEquivalentsLine(webEq);
      expect(weeklyOnly).toBe("≈ 0,5 tygodni");
      expect(line).toBe("brak kalibracji · ≈ 0,5 tygodni");
      expect(line).toContain(BRAK_KALIBRACJI);
      expect(line).toContain(weeklyOnly);
      expect(line).not.toBe(weeklyOnly);
    });
  });
});
describe("calendar granularity labels", () => {
  it("names calendar buckets, not reset windows", () => {
    const day: CalendarGranularity = "day";
    const week: CalendarGranularity = "week";
    const month: CalendarGranularity = "month";
    withLanguage("en", () => {
      expect(calendarGranularityLabel(day)).toBe("calendar day");
      expect(calendarGranularityLabel(week)).toBe("calendar week");
      expect(calendarGranularityLabel(month)).toBe("calendar month");
    });
    withLanguage("pl", () => {
      expect(calendarGranularityLabel(day)).toBe("dzień kalendarzowy");
      expect(calendarGranularityLabel(week)).toBe("tydzień kalendarzowy");
      expect(calendarGranularityLabel(month)).toBe("miesiąc kalendarzowy");
    });
  });
});
describe("provenance labels", () => {
  it("distinguishes measured / single / none and the other two axes", () => {
    withLanguage("en", () => {
      expect(capacityAxisLabel("measured")).toBe("measured");
      expect(capacityAxisLabel("single")).toBe("single reading");
      expect(capacityAxisLabel("none")).toBe("none");
      expect(priceAxisLabel("rate-card")).toBe("rate card");
      expect(priceAxisLabel("none")).toBe("none");
      expect(cadenceAxisLabel("declared")).toBe("declared");
      expect(cadenceAxisLabel("probe")).toBe("probe");
      expect(cadenceAxisLabel("default")).toBe("default");
      expect(cadenceAxisLabel("none")).toBe("none");
      expect(provenanceAxesLine(covered)).toBe("measured · rate card · declared");
      expect(provenanceLacksCalibration(covered)).toBe(false);
      expect(provenanceLacksCalibration(uncovered)).toBe(true);
      expect(provenanceLacksCalibration(noneCap)).toBe(true);
      const partial: Provenance = {
        ...covered,
        calibration_covers_period: false,
        coverage: "partial",
        measured_share: 0.68,
      };
      expect(provenanceLacksCalibration(partial)).toBe(false);
      expect(calibrationSummary(partial).usable).toBe(true);
    });
    withLanguage("pl", () => {
      expect(capacityAxisLabel("measured")).toBe("pomiar");
      expect(capacityAxisLabel("single")).toBe("jednorazowy");
      expect(capacityAxisLabel("none")).toBe("brak");
      expect(priceAxisLabel("rate-card")).toBe("cennik");
      expect(priceAxisLabel("none")).toBe("brak");
      expect(cadenceAxisLabel("declared")).toBe("deklaracja");
      expect(cadenceAxisLabel("probe")).toBe("sonda");
      expect(cadenceAxisLabel("default")).toBe("domyślny");
      expect(cadenceAxisLabel("none")).toBe("brak");
      expect(provenanceAxesLine(covered)).toBe("pomiar · cennik · deklaracja");
      expect(provenanceLacksCalibration(covered)).toBe(false);
      expect(provenanceLacksCalibration(uncovered)).toBe(true);
      expect(provenanceLacksCalibration(noneCap)).toBe(true);
      const partial: Provenance = {
        ...covered,
        calibration_covers_period: false,
        coverage: "partial",
        measured_share: 0.68,
      };
      expect(provenanceLacksCalibration(partial)).toBe(false);
      expect(calibrationSummary(partial).usable).toBe(true);
    });
  });
});
describe("utilisationVerdict", () => {
  it("reads the ratio as utilisation, because the plan price cancels out of it", () => {
    withLanguage("en", () => {
      const v = utilisationVerdict(419.14, 772.4)!;
      expect(v.label).toBe("used 184%");
      expect(v.ratio).toBeCloseTo(1.843, 2);
    });
    withLanguage("pl", () => {
      const v = utilisationVerdict(419.14, 772.4)!;
      expect(v.label).toBe("wyk. 184%");
      expect(v.ratio).toBeCloseTo(1.843, 2);
    });
  });
  it("flags anything over 100% as impossible, never as a bargain", () => {
    withLanguage("en", () => {
      const v = utilisationVerdict(419.14, 772.4)!;
      expect(v.impossible).toBe(true);
      expect(v.tone).toBe("warn");
      expect(v.hint).toContain("impossible");
      expect(v.label).not.toContain("bargain");
      expect(v.tone).not.toBe("ok");
    });
    withLanguage("pl", () => {
      const v = utilisationVerdict(419.14, 772.4)!;
      expect(v.impossible).toBe(true);
      expect(v.tone).toBe("warn");
      expect(v.hint).toContain("NIEMOŻLIWE");
      expect(v.label).not.toContain("taniej");
      expect(v.tone).not.toBe("ok");
    });
  });
  it("keeps a low utilisation as the warning it is, and a healthy one calm", () => {
    withLanguage("en", () => {
      const low = utilisationVerdict(483.6, 123.5)!;
      expect(low.label).toBe("used 26%");
      expect(low.impossible).toBe(false);
      expect(low.tone).toBe("warn");
      const ok = utilisationVerdict(3.95, 3.45)!;
      expect(ok.label).toBe("used 87%");
      expect(ok.tone).toBe("ok");
      expect(ok.impossible).toBe(false);
    });
    withLanguage("pl", () => {
      const low = utilisationVerdict(483.6, 123.5)!;
      expect(low.label).toBe("wyk. 26%");
      expect(low.impossible).toBe(false);
      expect(low.tone).toBe("warn");
      const ok = utilisationVerdict(3.95, 3.45)!;
      expect(ok.label).toBe("wyk. 87%");
      expect(ok.tone).toBe("ok");
      expect(ok.impossible).toBe(false);
    });
  });
  it("says nothing without both numbers, and never divides by zero", () => {
    expect(utilisationVerdict(null, 100)).toBeNull();
    expect(utilisationVerdict(100, null)).toBeNull();
    expect(utilisationVerdict(100, 0)).toBeNull();
    expect(utilisationVerdict(0, 100)).toBeNull();
  });
});
describe("calibrationSummary", () => {
  const base: Provenance = {
    capacity: "measured",
    price: "rate-card",
    cadence: "declared",
    calibration_covers_period: true,
    coverage: "full",
    measured_share: 1,
  };
  it("answers on partial coverage, and names how much of the range was measured", () => {
    withLanguage("en", () => {
      const summary = calibrationSummary({
        ...base,
        calibration_covers_period: false,
        coverage: "partial",
        measured_share: 0.68,
      });
      expect(summary.usable).toBe(true);
      expect(summary.label).toBe("coverage 68%");
      expect(summary.tone).toBe("warn");
      expect(summary.detail).toContain("68%");
      expect(summary.detail).toContain("not the percentage of the limit used");
    });
    withLanguage("pl", () => {
      const summary = calibrationSummary({
        ...base,
        calibration_covers_period: false,
        coverage: "partial",
        measured_share: 0.68,
      });
      expect(summary.usable).toBe(true);
      expect(summary.label).toBe("pokrycie 68%");
      expect(summary.tone).toBe("warn");
      expect(summary.detail).toContain("68%");
      expect(summary.detail).toContain("NIE jest procent wykorzystania limitu");
    });
  });
  it("refuses only when the calibration and the range share no day at all", () => {
    withLanguage("en", () => {
      const summary = calibrationSummary({
        ...base,
        calibration_covers_period: false,
        coverage: "none",
        measured_share: 0,
      });
      expect(summary.usable).toBe(false);
      expect(summary.label).toBe("period uncovered");
    });
    withLanguage("pl", () => {
      const summary = calibrationSummary({
        ...base,
        calibration_covers_period: false,
        coverage: "none",
        measured_share: 0,
      });
      expect(summary.usable).toBe(false);
      expect(summary.label).toBe("poza okresem");
    });
  });
  it("keeps full coverage separate from a single reading", () => {
    withLanguage("en", () => {
      expect(calibrationSummary(base).label).toBe("measurement");
      expect(calibrationSummary({ ...base, capacity: "single" }).label).toBe("1 reading");
      expect(calibrationSummary({ ...base, capacity: "none", coverage: "none", measured_share: 0 }).usable).toBe(false);
    });
    withLanguage("pl", () => {
      expect(calibrationSummary(base).label).toBe("pomiar");
      expect(calibrationSummary({ ...base, capacity: "single" }).label).toBe("1 odczyt");
      expect(calibrationSummary({ ...base, capacity: "none", coverage: "none", measured_share: 0 }).usable).toBe(false);
    });
  });
  it("shows partial date coverage and single-reading quality as two different facts", () => {
    withLanguage("en", () => {
      const summary = calibrationSummary({
        ...base,
        capacity: "single",
        calibration_covers_period: false,
        coverage: "partial",
        measured_share: 0.03,
      });
      expect(summary.label).toBe("coverage 3% · 1 reading");
      expect(summary.detail).toContain("one reading");
      expect(summary.detail).toContain("period before the first reading cannot be reconstructed");
    });
    withLanguage("pl", () => {
      const summary = calibrationSummary({
        ...base,
        capacity: "single",
        calibration_covers_period: false,
        coverage: "partial",
        measured_share: 0.03,
      });
      expect(summary.label).toBe("pokrycie 3% · 1 odczyt");
      expect(summary.detail).toContain("jednym odczycie");
      expect(summary.detail).toContain("sprzed pierwszego odczytu nie da się odtworzyć");
    });
  });
  it("keeps no-capacity dollar estimates separate from capacity calibration", () => {
    withLanguage("en", () => {
      const summary = calibrationSummary(noneCap);
      expect(summary.label).toBe("no calibration");
      expect(summary.usable).toBe(false);
      expect(summary.detail).toContain(
        "The adjacent dollar estimates do not require capacity calibration; they depend on configured prices and are not invoices.",
      );
    });
    withLanguage("pl", () => {
      const summary = calibrationSummary(noneCap);
      expect(summary.label).toBe(BRAK_KALIBRACJI);
      expect(summary.usable).toBe(false);
      expect(summary.detail).toContain(
        "Szacunki dolarowe obok nie wymagają kalibracji pojemności; zależą od skonfigurowanych cen i nie są fakturą.",
      );
    });
  });
});
describe("web MIX payload types vs server producer contract", () => {
  it("MutualExtends constants compiled (server ProjectCostResponse/RepoHistory ↔ web api.ts)", () => {
    expect(_costParity).toBe(true);
    expect(_historyParity).toBe(true);
    expect(_sliceParity).toBe(true);
    expect(_equivalentsParity).toBe(true);
  });
});
