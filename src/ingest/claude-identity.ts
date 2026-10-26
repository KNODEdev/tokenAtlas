import { discoveredVendorId } from "../providers/vendor-identity";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function claudeAccountKey(account: unknown, organization: unknown): string | null {
  return typeof account === "string" && typeof organization === "string" && UUID.test(account) && UUID.test(organization)
    ? `claude:${account.toLowerCase()}:${organization.toLowerCase()}` : null;
}
export function claudeIdentitySubscription(key: string, declarations: Array<{ id: string; account_key?: string }> = []): string {
  const ids = new Set(declarations.filter(d => d.account_key === key).map(d => d.id));
  return ids.size === 1 ? [...ids][0]! : discoveredVendorId({ vendor: "claude", key });
}
