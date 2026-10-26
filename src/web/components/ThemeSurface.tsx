import type { CSSProperties, ReactNode } from "react";
export function ThemeSurface({
  children,
  theme = "dark",
  pad = 16,
  style,
}: {
  children: ReactNode;
  theme?: "dark" | "light";
  pad?: number | string;
  style?: CSSProperties;
}) {
  return (
    <div
      data-theme={theme}
      style={{
        background: "var(--bg)",
        color: "var(--text)",
        fontFamily: "var(--font-sans)",
        padding: pad,
        borderRadius: "var(--r-card)",
        ...style,
      }}
    >
      {children}
    </div>
  );
}
