/** `GET/POST /api/setup/cloud-sessions`: the local interval of the Claude cloud session sync and its last run. */
export interface CloudSessionsResponse {
  setting: { minutes: number; source: "environment" | "settings" | "default" };
  status: {
    running: boolean;
    nextRunAt: string | null;
    error: string | null;
    last: { finishedAt: string; profiles: Array<{ archiveDir: string; sessions: number; changed: number; published: number; errors: string[] }> } | null;
  } | null;
}
