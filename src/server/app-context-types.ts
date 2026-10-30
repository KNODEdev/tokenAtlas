import type { SubscriptionV2, AccountsV2 } from "../config/accounts-v2";
import type { Database } from "../db/sqlite";
import type { LiveReadingsRefresh } from "./live-readings";
import type { ClaudeLoginService } from "./claude-login";
import type { AtlasSnapshotPublishResult, AtlasNewestValidSnapshot } from "../db/snapshot-contracts";
import type { SyncWatcher } from "../sync/watch";
import type { ResponseCache } from "./cache";
import type { createDataRead } from "./data-read";
import type { createDirectRead } from "./direct-read";
import type { ManualCapacityMeasurement } from "../shared/manual-capacity";
import type { CodexProfile } from "../providers/codex-identity";
import type { CodexDiscovery } from "./codex-discovery";
import type { VendorDiscovery } from "./vendor-discovery";
import type { VendorProfile } from "../providers/vendor-identity";
import type { RateCard } from "./pricing";
import type { ClaudeGaugeConfig } from "./claude-limit";
import type { GrokGaugeConfig } from "./grok-limit";
import type { CyclesConfig } from "./cycles";
import type { PlansConfig } from "./plans";
import type { PlansCatalog } from "./plans-catalog";
import type { SubscriptionHomeConflictError } from "./capacity-equivalents";
import type { EraIndex } from "./eras";
import type { SyncProcessRunner } from "./server-sync";

export interface SubscriptionAccount extends SubscriptionV2 {}

export interface AccountsConfig extends AccountsV2 { subscriptions: SubscriptionAccount[] }

export interface AppContext {
  readonly resolver?: import("./account-resolver").AccountResolver;
  sqlite: Database;
  dbPath?: string;
  syncRunner?: SyncProcessRunner;
  refreshLiveReadings?: LiveReadingsRefresh["run"];
  /** "Connect Claude" sign-ins started from the probe notices (`claude-login.ts`). */
  claudeLogin?: ClaudeLoginService;
  /** Claude cloud session sync (`claude-cloud-maintenance.ts`); absent in tests and contexts the server does not own. */
  cloudSessions?: ReturnType<typeof import("./claude-cloud-maintenance").startClaudeCloudMaintenance>;
  waitForBackgroundWriters?: () => Promise<void>;
  databaseRelocating?: boolean;
  relocateDatabase?: (destination: string) => void;
  /** Settings → move archive (`archive-move.ts`); present only under the supervisor that performs the switch. */
  archiveMove?: import("./archive-move").ArchiveMove;
  /** The first-run screen's "Start with these folders": releases a fresh database's first import. */
  confirmLocations?: () => void;
  /** Set when this process started the first import; the screen estimates its duration from it. */
  firstImport?: import("./first-import").FirstImport;
  snapshotPublisher?: (mode: "automatic" | "manual") => AtlasSnapshotPublishResult;
  snapshotDiscovery?: () => AtlasNewestValidSnapshot | null;
  syncWatcher?: SyncWatcher;
  responseCache?: ResponseCache;
  analysisReader?: ReturnType<typeof createDataRead>;
  /** Stored-row screens built off the HTTP thread (`direct-read.ts`). */
  directReader?: ReturnType<typeof createDirectRead>;
  /** Supplied by fixture callers; normal operation reads the Settings location. */
  manualCapacity?: ManualCapacityMeasurement[];
  // Test seam for probeTargets' "does this source directory exist here" check.
  probeSourceExists?: (sourceHome: string) => boolean;
  scanCodexProfiles?: () => CodexProfile[];
  codexDiscovery?: CodexDiscovery;
  vendorDiscovery?: VendorDiscovery;
  identityRevision?: number;
  scanVendorProfiles?: () => VendorProfile[];
  rateCards: RateCard;
  accounts: AccountsConfig;
  claudeGauge: ClaudeGaugeConfig;
  grokGauge: GrokGaugeConfig;
  cycles: CyclesConfig;
  plans: PlansConfig;
  plansCatalog: PlansCatalog;
  rootDir: string;
  homeToSubId: Map<string, string>;
  subIdToHomes: Map<string, string[]>;
  homeConflict: SubscriptionHomeConflictError | null;
  eras: EraIndex;
  eraErrors: string[];
}
