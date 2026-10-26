import { ARCHIVE_ROOT, requireArchiveRoot } from "../src/config/paths";
import { resolveDbPath } from "../src/db";
import { initializeArchiveWriterIdentity } from "../src/sync/archive-writers";
import { planArchiveCompression, startArchiveCompression, advanceArchiveCompression, archiveCompressionStatus, archiveCompressionVendors } from "../src/sync/archive-compression";

const [action = "plan", jobId, ...extra] = process.argv.slice(2);
const options = { archiveRoot: requireArchiveRoot(), databasePath: resolveDbPath() };
if (!["plan", "start", "resume", "status"].includes(action) || extra.length
  || (["resume", "status"].includes(action) ? !jobId : !!jobId))
  throw new Error("Usage: bun run archive:compress [plan | start | resume JOB_ID | status JOB_ID]");
if (action === "plan") {
  const plan = planArchiveCompression(options);
  console.log(JSON.stringify({ mode: "read-only plan", archive: ARCHIVE_ROOT, files: plan.files.length, sourceBytes: plan.sourceBytes,
    cutoff: new Date(plan.cutoff).toISOString(), providers: archiveCompressionVendors(options), minimumAgeDays: 7 }, null, 2));
} else if (action === "status") {
  console.log(JSON.stringify(archiveCompressionStatus(options, jobId!), null, 2));
} else {
  initializeArchiveWriterIdentity();
  const selected = action === "start" ? startArchiveCompression(options).jobId : jobId!;
  console.log(JSON.stringify({ jobId: selected, archive: ARCHIVE_ROOT }));
  let turn;
  do {
    turn = await advanceArchiveCompression(options, selected);
    console.log(JSON.stringify(turn));
  } while (turn.status === "pending");
  if (turn.status === "waiting") process.exitCode = 2;
}
