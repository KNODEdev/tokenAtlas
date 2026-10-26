/** `defaultHidden`: secondary detail a table starts without until the user chooses it (IA-43). */
export interface TableColumn { id: string; label: string; defaultHidden?: boolean }
export interface TableColumnPreferences { order: string[]; hidden: string[] }
export const tableColumnsKey = (id: string) => `tokenatlas.table-columns.v1:${id}`;

export function normalizeTableColumns(columns: readonly TableColumn[], saved: unknown): TableColumnPreferences {
  const ids = columns.map(column => column.id);
  const value = saved && typeof saved === "object" ? saved as Partial<TableColumnPreferences> : {};
  const known = (input: unknown) => Array.isArray(input) ? [...new Set(input.filter((id): id is string => typeof id === "string" && ids.includes(id)))] : [];
  const order = known(value.order);
  for (const id of ids) if (!order.includes(id)) order.push(id);
  // Without a saved choice, secondary columns start hidden; a saved choice always wins.
  const hidden = saved && typeof saved === "object" ? known(value.hidden) : columns.filter(column => column.defaultHidden).map(column => column.id);
  if (order.length && hidden.length === order.length) hidden.splice(hidden.indexOf(order[0]!), 1);
  return { order, hidden };
}

export function readTableColumns(id: string): unknown {
  try { return JSON.parse(localStorage.getItem(tableColumnsKey(id)) ?? "null"); }
  catch { return null; }
}

export function saveTableColumns(id: string, preferences: TableColumnPreferences): boolean {
  try { localStorage.setItem(tableColumnsKey(id), JSON.stringify(preferences)); return true; }
  catch { return false; }
}
