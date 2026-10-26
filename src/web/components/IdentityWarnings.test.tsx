import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { IdentityWarning } from "../lib/api";
import { IdentityWarnings, identityWarningSpec } from "./IdentityWarnings";

function warning(over: Partial<IdentityWarning> = {}): IdentityWarning {
  return {
    kind: "account-mismatch",
    vendor: "openai",
    subscription_id: "codex2",
    source: "C:/Users/sample_a/.codex2",
    observed: "account_0003@example.test",
    declared: "account_0001@example.test",
    ts: new Date(Date.now() - 90 * 60000).toISOString(),
    hint: "Źródło jest zalogowane na inne konto vendora niż deklaruje subskrypcja.",
    ...over,
  };
}

describe("IdentityWarnings", () => {
  it("renders nothing when there is nothing to warn about", () => {
    expect(renderToStaticMarkup(<IdentityWarnings warnings={[]} />)).toBe("");
  });

  it("renders a known kind with its own copy, tone and payload hint", () => {
    const html = renderToStaticMarkup(<IdentityWarnings warnings={[warning()]} />);
    expect(html).toContain("Vendor account mismatch");
    expect(html).toContain("Źródło jest zalogowane na inne konto vendora niż deklaruje subskrypcja.");
    expect(html).toContain("account_0003@example.test");
    expect(html).toContain("account_0001@example.test");
    expect(html).toContain("source: profile codex2");
    expect(html).not.toContain("C:/Users/sample_a/.codex2");
    expect(html).toContain("var(--warn)");
    expect(html).toContain('data-warning-kind="account-mismatch"');
  });

  it("renders an unknown kind through the generic template", () => {
    // A kind with no copy of its own (the retired `era-boundary`) still appears with no component change.
    const html = renderToStaticMarkup(
      <IdentityWarnings
        warnings={[
          warning({
            kind: "era-boundary",
            declared: null,
            hint: "Źródło zmieniło klaster kotwic — rozważ nową erę.",
          }),
        ]}
      />
    );
    expect(html).toContain('data-warning-kind="era-boundary"');
    expect(html).toContain("Era boundary");
    expect(html).toContain("Źródło zmieniło klaster kotwic — rozważ nową erę.");
    expect(html).toContain("declaration: —");
  });

  it("lists every warning and counts them in the header", () => {
    const html = renderToStaticMarkup(
      <IdentityWarnings
        warnings={[warning(), warning({ subscription_id: "claude", vendor: "anthropic" }), warning({ kind: "era-boundary" })]}
      />
    );
    expect(html).toContain('data-identity-warnings="3"');
    expect(html).toContain("3 warnings");
    expect(html.match(/data-warning-kind=/g)?.length).toBe(3);
  });

  it("redacts absolute paths and stack frames from warning hints", () => {
    const html = renderToStaticMarkup(
      <IdentityWarnings
        warnings={[warning({
          hint: "Profil C:\\Users\\Alice Smith\\.codex nie działa\n    at probe (C:\\private\\probe.ts:4:2)",
        })]}
      />
    );
    expect(html).toContain("[ścieżka ukryta]");
    expect(html).not.toContain("Alice Smith");
    expect(html).not.toContain("at probe");
  });

  it("keeps the card border on the strongest tone present", () => {
    const generic = renderToStaticMarkup(
      <IdentityWarnings warnings={[warning({ kind: "era-boundary" })]} />
    );
    expect(generic).toContain("var(--accent)");
    expect(generic).not.toContain("var(--warn)");
  });

  it("falls back to an informational spec for kinds it has no copy for", () => {
    expect(identityWarningSpec("account-mismatch").tone).toBe("warn");
    expect(identityWarningSpec("era-boundary")).toEqual({
      icon: "•",
      tone: "accent",
      title: "Era boundary",
    });
    expect(identityWarningSpec("").title).toBe("Warning");
  });
});
