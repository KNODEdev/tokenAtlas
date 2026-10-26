import { expect, test } from "bun:test";
import { Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DataTable, TableRow, TableColGroup, TableGrid, TableGridRow } from "./DataTable";
import { Table, Th, Td } from "./ui";
import { normalizeTableColumns, readTableColumns, saveTableColumns, tableColumnsKey } from "../lib/table-columns";

const columns = [{ id: "when", label: "UTC" }, { id: "plan", label: "Plan" }, { id: "value", label: "Value" }];
function storage(run: (values: Map<string, string>) => void) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value),
  } });
  try { run(values); } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor); else Reflect.deleteProperty(globalThis, "localStorage");
  }
}
const fixture = (id: string) => <Table tableId={id} fixed><TableColGroup><col data-width="date" /><col data-width="plan" /><col data-width="value" /></TableColGroup>
  <thead><TableRow header><Th columnId="when">UTC</Th><Th columnId="plan">Plan</Th><Th columnId="value">Value</Th></TableRow></thead>
  <tbody><TableRow><Td>2026-10-19 12:34</Td><Td>Pro</Td><Td>123 USD</Td></TableRow>
    <TableRow><Td colSpan={3}><button>Details</button></Td></TableRow></tbody></Table>;

test("column preferences validate malformed data, deduplicate IDs and keep at least one visible", () => {
  expect(normalizeTableColumns(columns, { order: ["value", "value", 4, "missing"], hidden: ["when", "plan", "value"] }))
    .toEqual({ order: ["value", "when", "plan"], hidden: ["when", "plan"] });
  expect(normalizeTableColumns(columns, null)).toEqual({ order: ["when", "plan", "value"], hidden: [] });
  // IA-43: secondary columns start hidden only until the user saves a choice.
  const withDetail = [...columns.slice(0, 2), { ...columns[2]!, defaultHidden: true }];
  expect(normalizeTableColumns(withDetail, null)).toEqual({ order: ["when", "plan", "value"], hidden: ["value"] });
  expect(normalizeTableColumns(withDetail, { order: ["when", "plan", "value"], hidden: [] })).toEqual({ order: ["when", "plan", "value"], hidden: [] });
});

test("preferences survive a new read, remain separate per table and append new columns", () => storage(() => {
  const value = { order: ["value", "when", "plan"], hidden: ["plan"] };
  expect(saveTableColumns("one", value)).toBe(true);
  expect(readTableColumns("one")).toEqual(value);
  expect(readTableColumns("two")).toBeNull();
  expect(normalizeTableColumns([...columns, { id: "new", label: "New" }], readTableColumns("one")))
    .toEqual({ order: ["value", "when", "plan", "new"], hidden: ["plan"] });
}));

test("table headers, body, widths and expanded-row spans follow the same saved order after remount", () => storage(() => {
  saveTableColumns("fixture", { order: ["value", "when", "plan"], hidden: ["plan"] });
  const html = renderToStaticMarkup(fixture("fixture"));
  expect(html).toContain('data-width="value"');
  expect(html.indexOf('data-width="value"')).toBeLessThan(html.indexOf('data-width="date"'));
  expect(html).not.toContain('data-width="plan"');
  expect(html).not.toContain('>Pro<');
  expect(html.indexOf('>123 USD<')).toBeLessThan(html.indexOf('>2026-10-19 12:34<'));
  expect(html).toContain('colSpan="2"');
  expect(html).toContain('class="ui-th data-table-last-heading"');
  expect(renderToStaticMarkup(fixture("fixture"))).toEqual(html);
  expect(renderToStaticMarkup(fixture("another"))).toContain('>Pro<');
}));

test("conditional columns use stable IDs rather than language or current position", () => storage(() => {
  saveTableColumns("conditional", { order: ["value", "plan", "when"], hidden: ["when"] });
  const html = renderToStaticMarkup(<DataTable tableId="conditional"><thead><TableRow header>
    <th data-column-id="when">Czas</th><th data-column-id="value">Kwota</th>
  </TableRow></thead><tbody><TableRow><td>Date</td><td>Amount</td></TableRow></tbody></DataTable>);
  expect(html).toContain('>Amount<'); expect(html).not.toContain('>Date<');
  expect(normalizeTableColumns(columns, readTableColumns("conditional")).order).toEqual(["value", "plan", "when"]);
}));

test("group subtotals retain correct associations when the user interleaves columns", () => storage(() => {
  saveTableColumns("spans", { order: ["a", "c", "b"], hidden: [] });
  const html = renderToStaticMarkup(<DataTable tableId="spans"><thead><TableRow header>
    <th data-column-id="a">A</th><th data-column-id="b">B</th><th data-column-id="c">C</th>
  </TableRow></thead><tbody><TableRow><td colSpan={2}><button>Subtotal editor</button></td><td>9</td></TableRow></tbody></DataTable>);
  expect(html).toContain('<td colSpan="1"><button>Subtotal editor</button></td><td>9</td><td colSpan="1"></td>');
  expect((html.match(/Subtotal editor/g) ?? []).length).toBe(1);
}));

test("custom row components and nested tables retain independent column contexts", () => storage(() => {
  const Row = () => <TableRow><Td>First</Td><Td>{fixture("inner")}</Td><Td>Last</Td></TableRow>;
  saveTableColumns("outer", { order: ["value", "when", "plan"], hidden: [] });
  const html = renderToStaticMarkup(<Table tableId="outer"><thead><TableRow header>{columns.map(column => <Th key={column.id} columnId={column.id}>{column.label}</Th>)}</TableRow></thead><tbody><Row /></tbody></Table>);
  expect(html.indexOf('>Last<')).toBeLessThan(html.indexOf('>First<'));
  expect(html).toContain('>Pro<');
  expect((html.match(/aria-label="Choose table columns"/g) ?? []).length).toBe(2);
}));

test("unavailable storage does not prevent rendering or turn a failed save into success", () => storage(values => {
  values.set(tableColumnsKey("bad"), "{"); expect(readTableColumns("bad")).toBeNull();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("blocked"); } });
  expect(readTableColumns("bad")).toBeNull(); expect(saveTableColumns("bad", { order: [], hidden: [] })).toBe(false);
  expect(renderToStaticMarkup(fixture("bad"))).toContain('>123 USD<');
}));

test("keyed fragments containing repeated header declarations retain every column and matching value", () => storage(() => {
  const html = renderToStaticMarkup(<Table tableId="fragment"><thead><TableRow header>{["in", "cache", "out"].map(id => <Fragment key={id}>
    <Th columnId="tokens">{id}</Th><Th columnId="price">{id} $</Th>
  </Fragment>)}</TableRow></thead><tbody><TableRow>{[1, 2, 3, 4, 5, 6].map(value => <Td key={value}>{value}</Td>)}</TableRow></tbody></Table>);
  expect((html.match(/<th /g) ?? []).length).toBe(6);
  expect((html.match(/<td /g) ?? []).length).toBe(6);
  expect(html).toContain('>6</td>'); expect(html).toContain('>cache $</th>');
}));

test("legacy grid tables project repeat/minmax tracks and custom button rows without changing their actions", () => storage(() => {
  saveTableColumns("grid", { order: ["column-2", "column-0", "column-1", "column-3"], hidden: ["column-1"] });
  const Row = () => <TableGridRow as="button" title="Open cycle" style={{ display: "grid", gridTemplateColumns: "150px repeat(3, minmax(0, 1fr))" }}>
    <span>Date</span><span>Tokens</span><span>Price</span><span>Quality</span>
  </TableGridRow>;
  const Frame = ({ children }: { children: import("react").ReactNode }) => <section>{children}</section>;
  const html = renderToStaticMarkup(<TableGrid tableId="grid"><Frame>
    <TableGridRow header style={{ gridTemplateColumns: "150px repeat(3, minmax(0, 1fr))" }}><span>UTC</span><span>Tokens</span><span>USD</span><span>Quality</span></TableGridRow>
    <Row />
  </Frame></TableGrid>);
  expect(html).toContain('grid-template-columns:minmax(0, 1fr) 150px minmax(0, 1fr)');
  expect(html).toContain('<button title="Open cycle"');
  expect(html.indexOf('>Price<')).toBeLessThan(html.indexOf('>Date<'));
  expect(html).not.toContain('>Tokens<'); expect(html).toContain('aria-label="Choose table columns"');
}));

test("legacy grid CSS templates keep calc tracks intact", () => storage(() => {
  saveTableColumns("calc-grid", { order: ["column-1", "column-0"], hidden: [] });
  const html = renderToStaticMarkup(<TableGrid tableId="calc-grid"><TableGridRow header template="calc(var(--s-10) * 4) minmax(0, 1fr)"><span>Date</span><span>Amount</span></TableGridRow></TableGrid>);
  expect(html).toContain('grid-template-columns:minmax(0, 1fr) calc(var(--s-10) * 4)');
}));
