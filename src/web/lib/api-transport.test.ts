import { afterEach, expect, spyOn, test } from "bun:test";
import { api, ApiError, bustApiMemo, onWrites, refreshApiData, type ProjectsResponse } from "./api";
import { get, onWrites as observeTransportWrites, post } from "./api/transport";
import { privacyEnabled, setPrivacyEnabled } from "./privacy";
import { displayPlanCatalog, publishDisplayPlanCatalog } from "./plan-catalog";
import type { PlansCatalog } from "./api/settings";

afterEach(() => bustApiMemo());

test("a saved catalog updates every plan reader and a late older read cannot restore old names", async () => {
  const restore = browserOrigin(), previous = displayPlanCatalog(), wasPrivate = privacyEnabled();
  setPrivacyEnabled(false);
  bustApiMemo();
  const saved: PlansCatalog = { provider_groups: [] };
  let finishRead!: (response: Response) => void;
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (_url: unknown, init?: RequestInit) =>
    init?.method === "POST" ? Response.json({ catalog: saved }) : new Promise<Response>(resolve => { finishRead = resolve; }), { preconnect() {} }) as typeof fetch);
  try {
    const pending = api.plansCatalog();
    await Promise.resolve();
    await api.plansCatalogSave(saved);
    expect(displayPlanCatalog()).toEqual(saved);
    finishRead(Response.json({ catalog: previous }));
    await pending;
    expect(displayPlanCatalog()).toEqual(saved);
  } finally {
    fetchMock.mockRestore(); restore(); setPrivacyEnabled(wasPrivate); publishDisplayPlanCatalog(previous);
  }
});

function browserOrigin() {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: "http://fixture.local" } } });
  return () => {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else delete (globalThis as { window?: unknown }).window;
  };
}

test("endpoint and transport readers share memoization and facade invalidation", async () => {
  const restore = browserOrigin();
  let calls = 0;
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () =>
    Response.json({ sequence: ++calls }), { preconnect() {} }) as typeof fetch);
  try {
    const fromEndpoint = await api.projects();
    expect(await get<ProjectsResponse>("/api/projects")).toBe(fromEndpoint);
    expect(calls).toBe(1);
    refreshApiData();
    const fromTransport = await get<ProjectsResponse>("/api/projects");
    expect(fromTransport).not.toBe(fromEndpoint);
    expect(await api.projects()).toBe(fromTransport);
    expect(calls).toBe(2);
  } finally {
    fetchMock.mockRestore();
    restore();
  }
});

test("failed writes retain public error identity, shared write state and memo invalidation", async () => {
  const restore = browserOrigin(), wasPrivate = privacyEnabled();
  setPrivacyEnabled(false);
  const facadeWrites: number[] = [], transportWrites: number[] = [];
  const stopFacade = onWrites(n => facadeWrites.push(n));
  const stopTransport = observeTransportWrites(n => transportWrites.push(n));
  let reads = 0;
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (_url: unknown, init?: RequestInit) =>
    init?.method === "POST"
      ? Response.json({ error: "period conflict", reason: "revision-conflict" }, { status: 409 })
      : Response.json({ sequence: ++reads }), { preconnect() {} }) as typeof fetch);
  try {
    const original = await api.projects();
    for (const write of [() => api.projectsRemap(), () => post("/api/projects/remap")]) {
      const error = await write().catch(error => error);
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ status: 409, reason: "revision-conflict", message: "period conflict" });
    }
    expect(facadeWrites).toEqual([0, 1, 0, 1, 0]);
    expect(transportWrites).toEqual(facadeWrites);
    expect(await api.projects()).not.toBe(original);
    expect(reads).toBe(2);
  } finally {
    stopFacade();
    stopTransport();
    fetchMock.mockRestore();
    setPrivacyEnabled(wasPrivate);
    restore();
  }
});


test("window end corrections use the shared JSON POST helper and repeated account query parameters", async () => {
  const restore = browserOrigin(), wasPrivate = privacyEnabled();
  setPrivacyEnabled(false);
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json({ revision: "one", windows: [], pending: false }), { preconnect() {} }) as typeof fetch);
  try {
    const body = { revision: "one", account: "a+b", counter: "weekly", window_start: "2026-09-01T00:00:00.000Z", cause: "provider" as const };
    await api.windowEndOverrides("codex", ["a+b", "alias"]);
    await api.saveWindowEndOverride("codex", ["a+b", "alias"], body);
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(new URL(String(url)).pathname).toBe("/api/window-end-overrides");
    expect(new URL(String(url)).searchParams.getAll("account")).toEqual(["a+b", "alias"]);
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(init?.body as string)).toEqual(body);
  } finally { fetchMock.mockRestore(); restore(); setPrivacyEnabled(wasPrivate); }
});
