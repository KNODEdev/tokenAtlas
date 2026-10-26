import { expect, test } from "bun:test";
import { allAccountsTarget, NAVIGATION, navLocation, navScreen, SCREEN_TITLES, screenAliases, screenLabel, screenTitle, type ScreenId } from "./screens";

test("the menu has six main entries and two system ones in the agreed order (IA-01)", () => {
  expect(NAVIGATION.filter(section => !section.system).map(section => section.label.pl))
    .toEqual(["Przegląd", "Limity", "Opłacalność", "Zużycie", "Projekty", "Modele"]);
  expect(NAVIGATION.filter(section => section.system).map(section => section.label.pl)).toEqual(["Dane i synchronizacja", "Ustawienia"]);
});

test("every screen has exactly one place in the menu and old names stay searchable (IA-02, IA-14)", () => {
  const views = NAVIGATION.flatMap(section => section.tabs.flatMap(tab => tab.views.map(view => view.screen)));
  expect(new Set(views).size).toBe(views.length);
  expect([...views].sort()).toEqual((Object.keys(SCREEN_TITLES) as ScreenId[]).sort());
  expect(navLocation("capacity").section.id).toBe("limits");
  expect(navLocation("periods").section.id).toBe("value");
  expect(NAVIGATION.find(section => section.id === "value")!.tabs.map(tab => tab.label.en))
    .toEqual(["Billing periods", "Plan comparison"]);
  expect(navLocation("events").section.id).toBe("usage");
  // Limits opens on Capacity, its first page tab.
  expect(navScreen("compare")).toBe("capacity");
  expect(NAVIGATION.find(section => section.id === "limits")!.tabs.map(tab => tab.label.pl)).toEqual(["Pojemność", "Okna limitu"]);
  expect(screenTitle("speed", "pl")).toBe("Modele");
  expect(screenLabel("compare", "pl")).toBe("Limity › Okna limitu › Porównaj");
  expect(screenLabel("projects", "en")).toBe("Projects");
  expect(screenAliases("history")).toEqual(["History", "Historia"]);
});

test("Models has separate page tabs for speed, the per-model table and traffic history", () => {
  const models = NAVIGATION.find(section => section.id === "models")!;
  expect(models.tabs.map(tab => tab.label.pl)).toEqual(["Szybkość", "Modele i źródła", "Historia ruchu"]);
  // Existing targets of "models" (events, data settings) land on the per-model table.
  expect(navLocation("models").tab.label.en).toBe("Models & sources");
  expect(screenLabel("model-traffic", "pl")).toBe("Modele › Historia ruchu");
});

test("old window targets keep their meaning for all subscriptions (02, old targets)", () => {
  expect(allAccountsTarget("history")).toBe("usage-history");
  expect(allAccountsTarget("analytics")).toBe("usage-pace");
  expect(allAccountsTarget("compare")).toBe("structure");
  expect(allAccountsTarget("patterns")).toBe("activity");
  expect(allAccountsTarget("models")).toBe("structure-models");
  expect(allAccountsTarget("model-traffic")).toBe("usage-history");
  expect(allAccountsTarget("capacity")).toBe("capacity");
  for (const screen of ["usage-history", "usage-pace", "structure", "activity", "structure-models"] as ScreenId[]) {
    expect(navLocation(screen).section.id).toBe("usage");
  }
});
