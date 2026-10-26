import { USAGE_VENDOR_IDS, type UsageVendorId } from "../sync/contracts";

/** A historical subscription identity, independent of its current login or source path. */
export type RebuildAccount = { vendor: UsageVendorId; account: string };
export type RebuildMeters = "archive";

export function normalizeRebuildMeters(input: unknown): RebuildMeters | undefined {
  if (input === undefined) return undefined;
  if (input !== "archive") throw new Error("Invalid account meter rebuild selector");
  return input;
}

export function normalizeRebuildAccounts(input: unknown): RebuildAccount[] {
  if (!Array.isArray(input) || input.length === 0) throw new Error("Account rebuild scope must contain at least one account");
  const seen = new Set<string>();
  const accounts = input.map((entry): RebuildAccount => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || Object.keys(entry).some(key => key !== "vendor" && key !== "account"))
      throw new Error("Invalid account rebuild selector");
    const { vendor, account } = entry as Record<string, unknown>;
    if (!USAGE_VENDOR_IDS.includes(vendor as UsageVendorId)) throw new Error(`Unknown account rebuild vendor: ${String(vendor)}`);
    if (typeof account !== "string" || !account.trim() || /[\u0000-\u001f\u007f]/.test(account))
      throw new Error("Invalid account rebuild identity");
    const selected = { vendor: vendor as UsageVendorId, account: account.trim().toLowerCase() };
    const key = JSON.stringify([selected.vendor, selected.account]);
    if (seen.has(key)) throw new Error(`Duplicate account rebuild identity: ${key}`);
    seen.add(key);
    return selected;
  });
  return accounts.sort((a, b) => USAGE_VENDOR_IDS.indexOf(a.vendor) - USAGE_VENDOR_IDS.indexOf(b.vendor)
    || (a.account < b.account ? -1 : a.account > b.account ? 1 : 0));
}
