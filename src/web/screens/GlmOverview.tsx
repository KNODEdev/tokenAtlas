import type { AccountCapabilities } from "../lib/api";
import type { RosterCard } from "../lib/roster";
import { glmSections } from "../components/GlmSections";
import { VendorOverview } from "../components/VendorOverview";
import { useI18n } from "../lib/i18n";
import { railWindowProjects } from "../components/WindowProjects";
import type { RailWindow } from "../lib/windows";
import { RailProjectSelection } from "../components/OverviewProjectSelector";

export function GlmOverview({ card, capabilities, projectWindow }: { card: RosterCard; capabilities: AccountCapabilities | null; projectWindow?: RailWindow | null }) {
  useI18n();
  const sections = glmSections({ card, capabilities });
  return <VendorOverview sections={{ ...sections, lead: <>{sections.lead}<RailProjectSelection key={card.id} account={card.id} window={projectWindow} /></>, projects: railWindowProjects(card.id, projectWindow) }} />;
}
