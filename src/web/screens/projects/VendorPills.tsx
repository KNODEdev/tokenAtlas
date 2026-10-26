import { vendorTone } from "./assignment";
import type { ApiProject } from "../../lib/api";
import { compact } from "../../lib/format";
import { Pill } from "../../components/ui";

const VENDORS = ["codex", "claude", "opencode"] as const;

export function VendorPills({ vendors }: { vendors: ApiProject["vendors"] }) {
  return (
    <div style={{ display: "flex", gap: 4 }}>
      {VENDORS.filter((v) => vendors[v]).map((v) => (
        <Pill key={v} tone={vendorTone(v)}>
          {v} {compact(vendors[v]?.tokens ?? 0)}
        </Pill>
      ))}
    </div>
  );
}
