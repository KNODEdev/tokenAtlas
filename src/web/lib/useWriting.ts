import { useEffect, useState } from "react";
import { onWrites } from "./api";
export function useWriting(): boolean {
  const [n, setN] = useState(0);
  useEffect(() => onWrites(setN), []);
  return n > 0;
}
