export const BUCKET_ID = "_tmp";
export const BUCKET_NAME = "_TMP";
export function isBucket(id: string | null | undefined): boolean {
  return id === BUCKET_ID;
}
export function withoutBucket<T extends { id: string }>(rows: readonly T[]): T[] {
  return rows.filter((r) => !isBucket(r.id));
}
