import type { AccountCapabilities } from "../lib/api";
import type { RosterCard } from "../lib/roster";
import { geminiSections } from "../components/GeminiSections";
import { VendorOverview } from "../components/VendorOverview";
import { useI18n } from "../lib/i18n";
import { railWindowProjects } from "../components/WindowProjects";
import type { RailWindow } from "../lib/windows";
import { RailProjectSelection } from "../components/OverviewProjectSelector";

export interface GeminiOverviewProps {
  card: RosterCard;
  pool: RosterCard[];
  onSelect: (id: string) => void;
  capabilities: AccountCapabilities | null;
  projectWindow?: RailWindow | null;
}

export function GeminiOverview(props: GeminiOverviewProps) {
  useI18n();
  const sections = geminiSections(props);
  return <VendorOverview sections={{ ...sections, lead: <>{sections.lead}<RailProjectSelection key={props.card.id} account={props.card.id} window={props.projectWindow} /></>, projects: railWindowProjects(props.card.id, props.projectWindow) }} />;
}
