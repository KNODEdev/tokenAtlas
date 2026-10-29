import { buildSetupState, setupArchiveRootsToCheck, assertConfigRootNotShadowed, assertArchiveRootNotShadowed, InheritedConfigRootError, InheritedArchiveRootError, saveSetup } from "./setup";
import { resolveDbPath } from "../db";
import type { AppContext } from "./app-context-types";
import type { AccountPeriodsContext } from "./account-periods-view";
import { buildAccountPeriodsView, previewPeriodEdit, applyPeriodEdit, PERIOD_REVISION_MISMATCH } from "./account-periods-view";
import { rebuildSubscriptionMaps, expandAccountPaths } from "./app-context";
import type { SetupSaveInput } from "./setup";
import { readSourceProfileConfiguration } from "./source-profile";
import type { SourceV2 } from "../config/accounts-v2";
import { parseAccountsV2 } from "../config/accounts-v2";
import { SubscriptionHomeConflictError } from "./capacity-equivalents";
import { AtlasSnapshotPoolLocationError, REPO_ROOT, configFile } from "../config/paths";
import path from "path";
import { readAccountsV2 } from "../config/accounts-document";
import { normPath } from "./account-scope";

export function handleSetup(ctx?: Pick<AppContext, "dbPath">): Response {
  return Response.json(buildSetupState(ctx?.dbPath ?? resolveDbPath()));
}

/**
 * The Settings card of docs/account-periods-model-2026-09-21.md §5. A GET builds the view; a POST
 * carries one change of the declarations file, as a preview or as a save. The save writes the
 * archive file and only then tries the tables, so a busy writer delays the rows, never the edit.
 */
export async function handleAccountPeriods(ctx: AppContext, req: Request): Promise<Response> {
  const periods: AccountPeriodsContext = {
    sqlite: ctx.sqlite, discovered: ctx.vendorDiscovery?.accounts, codexDiscovered: ctx.codexDiscovery?.accounts,
    plansCatalog: ctx.plansCatalog,
  };
  try {
    if (req.method === "GET") return Response.json(buildAccountPeriodsView(periods));
    if (req.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
    const edit = await req.json() as import("../shared/account-periods").PeriodEdit;
    if (edit.preview) return Response.json(previewPeriodEdit(periods, edit));
    // No cache invalidation: the period tables feed this card only, and a blanket drop would
    // rebuild reports that do not depend on them (`golden-rules.md` §3).
    const result = applyPeriodEdit(periods, edit);
    rebuildSubscriptionMaps(ctx);
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: message === PERIOD_REVISION_MISMATCH ? 409 : 400 });
  }
}

export async function handleSetupSave(ctx: AppContext, req: Request): Promise<Response> {
  const database = ctx.dbPath ?? resolveDbPath();
  let body: SetupSaveInput;
  try {
    body = (await req.json()) as SetupSaveInput;
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }
  if (!Array.isArray(body.subscriptions) && !Array.isArray(body.sources)) {
    return Response.json({ error: "potrzebna lista `subscriptions` albo `sources`" }, { status: 400 });
  }
  if (body.expectedSourceRevision && readSourceProfileConfiguration(ctx.sqlite).revision !== body.expectedSourceRevision) {
    return Response.json({ error: "Konfiguracja zmieniła się. Otwórz edytor ponownie." }, { status: 409 });
  }
  const seen = new Set<string>();
  for (const sub of body.subscriptions ?? []) {
    const id = (sub?.id ?? "").trim();
    if (!id) return Response.json({ error: "kazda subskrypcja potrzebuje `id`" }, { status: 400 });
    if (!(sub?.home ?? "").trim()) {
      return Response.json({ error: `subskrypcja '${id}' nie ma sciezki \`home\`` }, { status: 400 });
    }
    const key = [
      (sub.vendor ?? "codex").toLowerCase(),
      id.toLowerCase(),
      normPath(sub.home),
      sub.from ?? "",
      sub.until ?? "",
    ].join("\u0001");
    if (seen.has(key)) {
      return Response.json({ error: `subskrypcja '${id}' powtarza te sama sciezke home` }, { status: 400 });
    }
    seen.add(key);
  }
  try {
    for (const archive of setupArchiveRootsToCheck(body, database)) {
      const sources = (body.sources ?? (body.subscriptions ?? []).map(sub => ({ vendor: sub.vendor ?? "codex", home: sub.home,
        machine: sub.machine, login: sub.login, source_home: sub.source_home }))) as SourceV2[];
      const expanded = expandAccountPaths({ version: 2, subscriptions: [], sources }, { archive }).sources;
      parseAccountsV2({version:2, subscriptions:[], sources:expanded});
      const destinations = new Set<string>();
      for (const source of expanded) {
        const key = `${source.vendor}|${normPath(source.home)}`;
        if (destinations.has(key)) return Response.json({ error: `powtórzone źródło ${key}` }, { status: 400 });
        destinations.add(key);
      }
      for (const source of expanded) if (source.source_home && destinations.has(`${source.vendor}|${normPath(source.source_home)}`))
        return Response.json({error:`profil ${source.source_home} wskazuje na katalog archiwum innego źródła`},{status:400});
    }
    assertConfigRootNotShadowed(body);
    assertArchiveRootNotShadowed(body);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("accounts v2:")) return Response.json({error:e.message},{status:400});
    if (
      e instanceof SubscriptionHomeConflictError ||
      e instanceof InheritedConfigRootError ||
      e instanceof InheritedArchiveRootError ||
      e instanceof AtlasSnapshotPoolLocationError
    ) {
      return Response.json({ error: e.message }, { status: 400 });
    }
    throw e;
  }
  let result;
  try {
    result = saveSetup(body, {
      envFile: path.join(REPO_ROOT, ".env"),
      sqlite: ctx.sqlite,
      dbPath: database,
    });
  } catch (e) {
    if (e instanceof InheritedConfigRootError || e instanceof InheritedArchiveRootError || e instanceof AtlasSnapshotPoolLocationError) {
      return Response.json({ error: e.message }, { status: 400 });
    }
    return Response.json(
      { error: `Zapis konfiguracji nie powiódł się: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 }
    );
  }
  ctx.accounts = expandAccountPaths(readAccountsV2(configFile("accounts.json")));
  rebuildSubscriptionMaps(ctx);
  return Response.json({ ...result, ...(body.expectedSourceRevision ? {} : { state: buildSetupState(database) }) });
}
