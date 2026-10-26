import type { ScreenProps } from "../lib/screens";
import { useCodexSections } from "../components/CodexSections";
import { VendorOverview } from "../components/VendorOverview";
import { useI18n } from "../lib/i18n";
import { trafficRangeOf } from "../lib/codex-window-stats";
import { WindowProjects } from "../components/WindowProjects";

export function Overview(props: ScreenProps) {
  useI18n();
  const sections = useCodexSections(props), cycle = props.chosen ?? props.model.current;
  const range = cycle ? trafficRangeOf(cycle) : null;
  return <VendorOverview sections={{ ...sections, openWindows: () => props.goto("history"), projects: range
    ? <WindowProjects key={JSON.stringify([props.account, range.from, range.until])} account={props.account} from={range.from} until={range.until} /> : undefined }} />;
}
