import fs from "node:fs";
import path from "node:path";
import { atomicArchiveWrite } from "../sync/archive-publication";
import { CONFIG_ROOT } from "../config/paths";
import type { ManualCapacityInput, ManualCapacityMeasurement, ManualCapacityStore } from "../shared/manual-capacity";
import { parseCapacityCounter } from "../shared/manual-capacity";
import { subscriptionAccountingAdapter, usageLedgerProviderIds } from "./subscription-accounting-adapters";

const filename = (provider: string) => `manual-capacity-${provider}.json`;
const iso = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && /Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

function validInput(value: unknown, provider: string): value is ManualCapacityInput {
  if (!value || typeof value !== "object") return false;
  const m = value as ManualCapacityInput;
  if ((m.id !== undefined && (typeof m.id !== "string" || !/^[\w-]{1,80}$/.test(m.id))) || !iso(m.start) || !iso(m.end)
    || Date.parse(m.end) <= Date.parse(m.start) || Date.parse(m.end) - Date.parse(m.start) > 366 * 86400000
    || typeof m.start_percent !== "number" || typeof m.end_percent !== "number"
    || !Number.isFinite(m.start_percent) || !Number.isFinite(m.end_percent)
    || m.start_percent < 0 || m.end_percent > 100 || m.end_percent <= m.start_percent
    || typeof m.approximate_time !== "boolean" || typeof m.note !== "string" || m.note.length > 1000) return false;
  try {
    const counter = parseCapacityCounter(m.counter);
    const adapter = subscriptionAccountingAdapter(provider);
    return !!counter && adapter.counterKinds.includes(counter[0])
      && (provider !== "gemini" || /^(gemini|claude)/i.test(counter[1]));
  } catch { return false; }
}

export function readManualCapacity(provider: string, root = CONFIG_ROOT): ManualCapacityStore {
  if (!usageLedgerProviderIds().includes(provider)) throw new Error("Nieobsługiwany dostawca pomiaru");
  try {
    const store = JSON.parse(fs.readFileSync(path.join(root, filename(provider)), "utf8")) as ManualCapacityStore;
    if (typeof store.revision !== "string" || !Array.isArray(store.measurements) || !store.measurements.every(m =>
      validInput(m, provider) && typeof m.account === "string" && !!m.account && iso(m.updated_at))) throw new Error("Nieprawidłowy plik ręcznych pomiarów");
    return store;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { revision: "empty", measurements: [] };
    throw error;
  }
}

export function manualCapacityStamp(root = CONFIG_ROOT): unknown {
  return usageLedgerProviderIds().map(provider => readManualCapacity(provider, root));
}

export async function handleManualCapacity(req: Request, root = CONFIG_ROOT): Promise<Response> {
  const response = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
  if (!["GET", "POST"].includes(req.method)) return response({ error: "Method not allowed" }, 405);
  const params = new URL(req.url).searchParams;
  const provider = params.get("provider") ?? "", account = (params.get("account") ?? "").toLowerCase();
  if (!usageLedgerProviderIds().includes(provider) || !/^[a-z0-9][a-z0-9_.@+-]{0,199}$/.test(account) || ["all", "__all__"].includes(account)) return response({ error: "Wybierz dostawcę i jedno konto" }, 400);
  let body: { revision?: string; measurement?: ManualCapacityInput; remove?: string } | undefined;
  if (req.method === "POST") {
    try { body = await req.json(); } catch { return response({ error: "Oczekiwano JSON" }, 400); }
    if (!body || typeof body.revision !== "string" || (body.remove !== undefined
      ? typeof body.remove !== "string" || !!body.measurement : !validInput(body.measurement, provider))) {
      return response({ error: "Podaj prawidłowy okres oraz rosnący procent 0–100 w obrębie jednego cyklu" }, 400);
    }
    if (body.measurement && Date.parse(body.measurement.end) > Date.now()) return response({ error: "Pomiar nie może dotyczyć przyszłości" }, 400);
  }
  try {
    let store = readManualCapacity(provider, root);
    if (body) {
      if (body.revision !== store.revision) return response({ error: "Pomiary zmieniły się. Odśwież listę przed zapisem." }, 409);
      const id = body.remove ?? body.measurement?.id;
      if (id && !store.measurements.some(m => m.id === id && m.account === account)) return response({ error: "Nie znaleziono pomiaru tego konta" }, 404);
      const measurements = store.measurements.filter(m => m.id !== id);
      if (body.measurement) {
        const m = body.measurement;
        if (measurements.some(other => other.account === account && other.counter === m.counter
          && Date.parse(other.start) < Date.parse(m.end) && Date.parse(other.end) > Date.parse(m.start))) return response({ error: "Okres nakłada się na inny ręczny pomiar tego licznika. Edytuj istniejący wpis." }, 409);
        measurements.push({ id: id ?? crypto.randomUUID(), account, counter: m.counter, start: m.start, end: m.end,
          start_percent: m.start_percent, end_percent: m.end_percent, approximate_time: m.approximate_time, note: m.note.trim(), updated_at: new Date().toISOString() });
      }
      if (measurements.length > 2000) return response({ error: "Osiągnięto limit 2000 ręcznych pomiarów" }, 400);
      store = { revision: crypto.randomUUID(), measurements };
      atomicArchiveWrite(path.join(root, filename(provider)), JSON.stringify(store, null, 2) + "\n");
    }
    return response({ ...store, measurements: store.measurements.filter(m => m.account === account) });
  } catch (error) { return response({ error: (error as Error).message }, 503); }
}
