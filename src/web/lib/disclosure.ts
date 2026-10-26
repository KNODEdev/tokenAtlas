import { useCallback, useState } from "react";

const disclosureKey = (id: string) => `tokenatlas.disclosure.v1:${id}`;

/** A report block's remembered open state; `fallback` when the viewer never chose (IA-2026-10-19 v1.1, IA-43). */
export function readDisclosure(id: string, fallback: boolean): boolean {
  try {
    const value = localStorage.getItem(disclosureKey(id));
    return value === "1" ? true : value === "0" ? false : fallback;
  } catch { return fallback; }
}

/**
 * Open state of a report's detail block, kept per block across visits and reloads. Detail parts start
 * open (owner decision 2026-10-20); closing one is remembered for that block only.
 */
export function useDisclosure(id: string, fallback = true): [boolean, (open: boolean) => void] {
  const [open, setOpenState] = useState(() => readDisclosure(id, fallback));
  const setOpen = useCallback((next: boolean) => {
    setOpenState(next);
    try { localStorage.setItem(disclosureKey(id), next ? "1" : "0"); } catch { /* Storage may be unavailable; the state still applies now. */ }
  }, [id]);
  return [open, setOpen];
}
