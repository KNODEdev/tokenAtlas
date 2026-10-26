import type { MessageTranslator } from "../../lib/i18n";
import { calendarPlanCostHint, polishPlural } from "../../lib/mixFormat";

export type Translate = MessageTranslator;
export function countLabel(
  t: Translate,
  n: number,
  enOne: string,
  enMany: string,
  plOne: string,
  plFew: string,
  plMany: string,
): string {
  return t(Math.abs(n) === 1 ? enOne : enMany, polishPlural(n, plOne, plFew, plMany));
}
export function declaredPlanCostHint(t: Translate): string {
  return calendarPlanCostHint(t);
}
export function hours(seconds: number): number {
  return seconds / 3600;
}
