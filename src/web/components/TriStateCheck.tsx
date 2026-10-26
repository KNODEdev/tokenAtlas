import { useEffect, useRef } from "react";

/** A checkbox whose third state ("some of its parts") is the native indeterminate one. */
export function TriStateCheck({ state, label, onChange }: { state: "all" | "some" | "none"; label: string; onChange: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = state === "some"; });
  return <input ref={ref} type="checkbox" checked={state === "all"} aria-checked={state === "some" ? "mixed" : state === "all"}
    aria-label={label} onChange={onChange} />;
}
