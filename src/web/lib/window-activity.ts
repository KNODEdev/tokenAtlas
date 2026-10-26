import type { WindowActivity } from "../../shared/window-activity";
import type { CoursePoint } from "./window-status";

/** Split at inactive spans without drawing a measured rise through another plan's usage. */
export function activeCourses(points: readonly CoursePoint[], activity: WindowActivity | undefined,
  startMs: number, spanMs: number): CoursePoint[][] {
  if (!activity) return [[...points]];
  return activity.spans.flatMap(span => {
    const from = (Date.parse(span.start) - startMs) / spanMs * 100;
    const until = (Date.parse(span.end) - startMs) / spanMs * 100;
    const selected = points.filter(point => point.t >= from && point.t <= until);
    return selected.length ? [selected] : [];
  });
}
