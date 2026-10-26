import { useLayoutEffect, useState, type RefObject } from "react";

/** Never shorter than this, so a short window still shows a usable list. */
const MIN_PX = 420;
/** A small gap and the shell's 24 px bottom padding stay below, so the page itself does not scroll. */
const BOTTOM_PX = 40;

/**
 * The height that lets a workspace fill the window below its top edge (user, 2026-10-12): its columns scroll on
 * their own instead of the page. Null until measured; re-measured on resize and when `deps` change.
 */
export function useFillHeight(ref: RefObject<HTMLElement | null>, deps: unknown[] = []): number | null {
  const [height, setHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const measure = () => {
      const node = ref.current;
      if (!node?.getBoundingClientRect) return;
      const top = node.getBoundingClientRect().top + window.scrollY;
      setHeight(Math.max(MIN_PX, window.innerHeight - top - BOTTOM_PX));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, deps);
  return height;
}
