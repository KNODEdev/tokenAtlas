import { useEffect, useState } from "react";
export function useDebounced<T>(value: T, delayMs = 350): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (Object.is(settled, value)) return;
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs, settled]);
  return settled;
}
