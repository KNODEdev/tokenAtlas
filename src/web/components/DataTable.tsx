import { Children, Fragment, cloneElement, createContext, isValidElement, useContext, useMemo, useState, type ReactElement, type ReactNode, type TableHTMLAttributes, type HTMLAttributes, type Ref, type CSSProperties } from "react";
import { useI18n } from "../lib/i18n";
import { normalizeTableColumns, readTableColumns, saveTableColumns, type TableColumn, type TableColumnPreferences } from "../lib/table-columns";
import { CodexColumnsDrawer } from "./CodexColumnsDrawer";
import { compareTableValues, displayedTableValue, type TableSort, type TableSorting, type TableSortValue } from "../lib/table-sort";
import "./DataTable.css";

type CellProps = { children?: ReactNode; colSpan?: number; columnId?: string; defaultHidden?: boolean; sortValue?: TableSortValue; "data-sort-value"?: TableSortValue; "data-column-id"?: string; "data-column-label"?: string; "aria-label"?: string; "aria-sort"?: "ascending" | "descending" | "none"; label?: string; title?: string; className?: string };
type Element = ReactElement<CellProps>;

/** Flatten only fragments: never execute child components to discover table data. */
function tableElements(children: ReactNode, prefix = ""): Element[] {
  return Children.toArray(children).flatMap(child => !isValidElement<CellProps>(child) ? []
    : child.type === Fragment ? tableElements(child.props.children, `${prefix}${child.key}/`) : [cloneElement(child, { key: `${prefix}${child.key}` })]);
}

function labelOf(node: ReactNode): string {
  return Children.toArray(node).map(child => typeof child === "string" || typeof child === "number" ? String(child)
    : isValidElement<CellProps>(child) ? child.props["aria-label"] ?? child.props.label ?? labelOf(child.props.children) : "").join(" ").trim();
}

function tableSchema(children: ReactNode, fallback: (n: number) => string): TableColumn[] {
  const head = tableElements(children).find(element => element.type === "thead");
  const row = head && tableElements(head.props.children)[0];
  return schemaFromCells(row?.props.children, fallback);
}

function schemaFromCells(children: ReactNode, fallback: (n: number) => string): TableColumn[] {
  const cells = tableElements(children);
  return cells.map((cell, index) => ({
    id: cell.props.columnId ?? cell.props["data-column-id"] ?? `column-${index}`,
    label: cell.props["data-column-label"] || labelOf(cell.props.children) || cell.props["aria-label"] || cell.props.title || fallback(index + 1),
    ...(cell.props.defaultHidden ? { defaultHidden: true } : {}),
  })).map((column, index, all) => all.some((other, i) => i !== index && other.id === column.id)
    ? { ...column, id: `${column.id}:${cells[index]!.key}` } : column);
}

export function useTableColumns(id: string, columns: readonly TableColumn[]) {
  const stored = useMemo(() => readTableColumns(id), [id]);
  const [edits, setEdits] = useState<Record<string, unknown>>({});
  const saved = Object.hasOwn(edits, id) ? edits[id] : stored;
  const [open, setOpen] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const preferences = useMemo(() => normalizeTableColumns(columns, saved), [columns, saved]);
  const selected = useMemo(() => preferences.order.filter(column => !preferences.hidden.includes(column)), [preferences]);
  const commit = (next: TableColumnPreferences) => {
    setEdits(previous => ({ ...previous, [id]: next })); setSaveError(!saveTableColumns(id, next));
  };
  const choose = (ids: string[]) => {
    const selected = [...new Set(ids.filter(id => columns.some(column => column.id === id)))];
    if (!selected.length) return;
    // Retain unavailable columns when a conditional table schema temporarily omits them.
    const prior = saved && typeof saved === "object" ? saved as Partial<TableColumnPreferences> : {};
    const absent = (ids: unknown) => Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string" && !columns.some(column => column.id === id)) : [];
    commit({ order: [...selected, ...preferences.order.filter(id => !selected.includes(id)), ...absent(prior.order)],
      hidden: [...preferences.order.filter(id => !selected.includes(id)), ...absent(prior.hidden)] });
  };
  const { t } = useI18n();
  const trigger = useMemo(() => <button type="button" className="ui-button data-table-columns-button" aria-label={t("Choose table columns", "Wybierz kolumny tabeli")}
    title={t("Columns: visibility and order", "Kolumny: widoczność i kolejność")} aria-haspopup="dialog" aria-expanded={open} onClick={event => { event.stopPropagation(); setOpen(true); }}>▥</button>, [open, t]);
  const drawer = open && <CodexColumnsDrawer columns={columns} selected={selected} onChange={choose} onClose={() => setOpen(false)}
    onReset={() => commit({ order: columns.map(column => column.id), hidden: columns.filter(column => column.defaultHidden).map(column => column.id) })} saveError={saveError} />;
  return { selected, trigger, drawer };
}

type TableContextValue = { indices: number[]; trigger: ReactNode; headings?: ReactNode[]; columns?: TableColumn[]; sort?: TableSort | null };
const TableContext = createContext<TableContextValue | null>(null);

/** Reorder real React cells, including spans; retain content, handlers and nested component ownership. */
function projectTableCells(cells: Element[], indices: number[]): Element[] {
  const owner: { cell: Element; index: number }[] = [];
  cells.forEach((cell, index) => { for (let i = 0; i < (cell.props.colSpan ?? 1); i++) owner.push({ cell, index }); });
  const result: Element[] = [];
  const segments = new Map<number, number>();
  for (let cursor = 0; cursor < indices.length;) {
    const item = owner[indices[cursor]!];
    if (!item) { cursor++; continue; }
    let end = cursor + 1;
    while (end < indices.length && owner[indices[end]!]?.index === item.index) end++;
    const segment = segments.get(item.index) ?? 0;
    segments.set(item.index, segment + 1);
    result.push(cloneElement(item.cell, { key: `${item.cell.key ?? item.index}:${segment}`,
      ...(segment ? { children: null } : {}),
      ...(item.cell.props.colSpan !== undefined || end - cursor > 1 ? { colSpan: end - cursor } : {}) }));
    cursor = end;
  }
  return result;
}

export function TableRow({ children, header, ...props }: HTMLAttributes<HTMLTableRowElement> & { header?: boolean; ref?: Ref<HTMLTableRowElement> }) {
  const table = useContext(TableContext);
  if (!table) return <tr {...props}>{children}</tr>;
  const original = tableElements(children).map((cell, index) => header && table.headings?.[index]
    ? cloneElement(cell, { children: table.headings[index], "aria-sort": table.sort && table.sort.column === table.columns?.[index]?.id
      ? table.sort.direction === "asc" ? "ascending" : "descending" : "none" }) : cell);
  const cells = projectTableCells(original, table.indices);
  if (header && cells.length) {
    const last = cells[cells.length - 1]!;
    cells[cells.length - 1] = cloneElement(last, { className: [last.props.className, "data-table-last-heading"].filter(Boolean).join(" "),
      children: <>{last.props.children}{table.trigger}</> });
  }
  return <tr {...props}>{cells}</tr>;
}

export function TableColGroup({ children, ...props }: HTMLAttributes<HTMLTableColElement>) {
  const table = useContext(TableContext);
  const cols = tableElements(children);
  return <colgroup {...props}>{table ? table.indices.map(index => cols[index] && cloneElement(cols[index]!, { key: index })) : children}</colgroup>;
}

/** The analytical grids share the same column model while retaining their chart cells. */
export function TableGridCells({ children, columns, selected, trigger }: {
  children: ReactNode; columns: readonly TableColumn[]; selected: string[]; trigger?: ReactNode;
}) {
  const cells = projectTableCells(tableElements(children), selected.map(id => columns.findIndex(column => column.id === id)));
  if (trigger && cells.length) {
    const last = cells[cells.length - 1]!;
    cells[cells.length - 1] = cloneElement(last, { className: [last.props.className, "data-table-last-heading"].filter(Boolean).join(" "), children: <>{last.props.children}{trigger}</> });
  }
  return <>{cells}</>;
}

type RowGroup = { element: Element; cells: Element[] };

/** A fragment keeps its expanded details attached; opaque row components retain their ownership. */
function bodyGroups(children: ReactNode): RowGroup[] | null {
  const groups: RowGroup[] = [];
  for (const child of Children.toArray(children)) {
    if (!isValidElement<CellProps>(child)) continue;
    const row = child.type === Fragment ? tableElements(child.props.children)[0] : child;
    if (!row || (row.type !== TableRow && row.type !== "tr")) return null;
    const cells = tableElements(row.props.children);
    if (!cells.length || cells.some(cell => (cell.props.colSpan ?? 1) > 1)) return null;
    groups.push({ element: child, cells });
  }
  return groups;
}

function cellValue(cell: Element | undefined, locale: string): TableSortValue {
  if (!cell) return null;
  if (Object.hasOwn(cell.props, "sortValue")) return cell.props.sortValue;
  if (Object.hasOwn(cell.props, "data-sort-value")) return cell.props["data-sort-value"];
  return displayedTableValue(labelOf(cell.props.children), locale);
}

function hasControl(node: ReactNode): boolean {
  return Children.toArray(node).some(child => isValidElement<CellProps>(child) &&
    ((typeof child.type !== "string" && child.type !== Fragment) || ["button", "input", "select", "a"].includes(String(child.type)) || hasControl(child.props.children)));
}

export type TableSortProps = { defaultSort?: TableSort; sorting?: TableSorting; sortable?: boolean };

export function DataTable({ tableId, children, defaultSort, sorting, sortable = true, ...props }: TableHTMLAttributes<HTMLTableElement> & { tableId: string } & TableSortProps) {
  const { t, locale } = useI18n();
  const [localSort, setLocalSort] = useState<TableSort | null>(defaultSort ?? null);
  const sort = sorting ? sorting.sort : localSort;
  const columns = useMemo(() => tableSchema(children, n => `${t("Column", "Kolumna")} ${n}`), [children, t]);
  const elements = tableElements(children);
  const head = elements.find(element => element.type === "thead");
  const header = head && tableElements(head.props.children)[0];
  const headerCells = tableElements(header?.props.children);
  const bodies = elements.filter(element => element.type === "tbody");
  const groups = bodies.length === 1 ? bodyGroups(bodies[0]!.props.children) : null;
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: "base" });
  const headings = headerCells.map((cell, index) => {
    const column = columns[index]!;
    const parts = Children.toArray(cell.props.children);
    const label = parts.filter(part => !hasControl(part));
    const controls = parts.filter(part => hasControl(part));
    const values = groups?.map(group => cellValue(group.cells[index], locale)) ?? [];
    const labelText = labelOf(label);
    const enabled = sortable && (sorting ? sorting.columns.includes(column.id) : !!groups?.length && values.some(value => value != null && value !== ""))
      && !!labelText && !/^(?:actions?|akcj[ae])$/i.test(labelText);
    if (!enabled) return null;
    const active = sort?.column === column.id;
    const direction = active ? sort.direction === "asc" ? "desc" : "asc" : values.some(value => typeof value === "number") ? "desc" : "asc";
    const title = `${labelText}: ${direction === "asc" ? t("sort ascending", "sortuj rosnąco") : t("sort descending", "sortuj malejąco")}`;
    return <><button type="button" className="data-table-sort-button" title={title} onClick={event => {
      event.stopPropagation();
      const next: TableSort = { column: column.id, direction };
      if (sorting) sorting.onSort(next); else setLocalSort(next);
    }}>{label}<span className="data-table-sort-mark" aria-hidden="true" /></button>{controls}</>;
  });
  const columnIndex = sort ? columns.findIndex(column => column.id === sort.column) : -1;
  const content = !sorting && sortable && groups && sort && columnIndex >= 0 ? elements.map(element => element.type !== "tbody" ? element
    : cloneElement(element, { children: [...groups].sort((a, b) => compareTableValues(cellValue(a.cells[columnIndex], locale), cellValue(b.cells[columnIndex], locale), sort, collator)).map(group => group.element) })) : children;
  const settings = useTableColumns(tableId, columns);
  const indices = useMemo(() => settings.selected.map(id => columns.findIndex(column => column.id === id)), [settings.selected, columns]);
  const trigger = settings.trigger;
  const context = { indices, trigger, headings, columns, sort };
  return <TableContext.Provider value={context}>
    <table {...props} data-table-id={tableId}>{content}</table>{settings.drawer}
  </TableContext.Provider>;
}

const GridContext = createContext<TableContextValue | null>(null);

function gridHeader(children: ReactNode): Element | undefined {
  for (const child of tableElements(children)) {
    if (child.type === TableGridRow && (child.props as { header?: boolean }).header) return child;
    // Only authored elements are inspected; row components remain under React's ownership.
    const header = gridHeader(child.props.children);
    if (header) return header;
  }
}

/** Split track lists at top-level spaces; minmax/calc tracks remain intact. */
function gridTracks(template: string): string[] {
  let depth = 0, start = 0;
  const tracks: string[] = [];
  for (let index = 0; index <= template.length; index++) {
    if (template[index] === "(") depth++;
    if (template[index] === ")") depth--;
    if (index === template.length || (depth === 0 && /\s/.test(template[index]!))) {
      const track = template.slice(start, index).trim();
      if (track) {
        const repeat = /^repeat\((\d+),\s*(.*)\)$/.exec(track);
        tracks.push(...(repeat ? Array.from({ length: Number(repeat[1]) }, () => gridTracks(repeat[2]!)).flat() : [track]));
      }
      start = index + 1;
    }
  }
  return tracks;
}

export function TableGrid({ tableId, children }: { tableId: string; children: ReactNode }) {
  const { t } = useI18n();
  const columns = useMemo(() => schemaFromCells(gridHeader(children)?.props.children, n => `${t("Column", "Kolumna")} ${n}`), [children, t]);
  const settings = useTableColumns(tableId, columns);
  const indices = useMemo(() => settings.selected.map(id => columns.findIndex(column => column.id === id)), [settings.selected, columns]);
  const trigger = settings.trigger;
  const context = useMemo(() => ({ indices, trigger }), [indices, trigger]);
  return <GridContext.Provider value={context}>{children}{settings.drawer}</GridContext.Provider>;
}

export function TableGridRow({ as: Tag = "div", header, children, style, template, ...props }: HTMLAttributes<HTMLElement> & {
  as?: "div" | "button"; header?: boolean; template?: string; style?: CSSProperties;
}) {
  const grid = useContext(GridContext);
  if (!grid) return <Tag {...props} style={style}>{children}</Tag>;
  const tracks = gridTracks(template ?? String(style?.gridTemplateColumns ?? ""));
  const cells = projectTableCells(tableElements(children), grid.indices);
  if (header && cells.length) {
    const last = cells[cells.length - 1]!;
    cells[cells.length - 1] = cloneElement(last, { className: [last.props.className, "data-table-last-heading"].filter(Boolean).join(" "), children: <>{last.props.children}{grid.trigger}</> });
  }
  return <Tag {...props} style={{ ...style, gridTemplateColumns: grid.indices.map(index => tracks[index] ?? "minmax(0, 1fr)").join(" ") }}>{cells}</Tag>;
}
