import type { NoticePool } from "../shared/credit-notices";
import { decodeCreditPools, statesCreditPools } from "../shared/credit-pools";

/** The pools a stored reading states, for the credit-notice producer; null when the reading states nothing about pools. */
export function decodeNoticePools(provider: string, extra: Record<string, unknown>): NoticePool[] | null {
  return statesCreditPools(provider, extra) ? decodeCreditPools(provider, extra) : null;
}
