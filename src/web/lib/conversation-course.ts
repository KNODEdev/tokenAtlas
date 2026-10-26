import type { ConversationCall, ConversationCourse } from "../../shared/conversation-course";
import { previewContextAmount } from "../../shared/context-price";

export function conversationApiValue(call: ConversationCall, context: boolean): number | null {
  return previewContextAmount(call.api_usd, call.context_price, context);
}
const median = (values: Array<number | null>): number | null => {
  if (!values.length || values.some(value => value === null || !Number.isFinite(value))) return null;
  const sorted = (values as number[]).toSorted((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};
export const conversationInput = (call: ConversationCall) => call.tokens ? call.tokens.input + call.tokens.cache_read + call.tokens.cache_write : null;
/** Cache reads as a share of this entry's whole input; no input has no defined share. */
export function conversationCacheShare(call: ConversationCall): number | null {
  const input = conversationInput(call);
  return input !== null && input > 0 ? call.tokens!.cache_read / input * 100 : null;
}
/** Fixed disjoint edge cohorts; missing values never become zero or shrink the sample. */
export function conversationSummary(course: ConversationCourse, context = false) {
  if (course.calls.length < 10 || course.truncated || course.excluded || course.approximate_order) return null;
  const first = course.calls.slice(0, 5), last = course.calls.slice(-5);
  const allInput = course.calls.map(conversationInput);
  const complete = allInput.every(value => value !== null);
  const total = complete ? (allInput as number[]).reduce((sum, value) => sum + value, 0) : 0;
  return { input: [median(first.map(conversationInput)), median(last.map(conversationInput))] as const,
    api: [median(first.map(call => conversationApiValue(call, context))), median(last.map(call => conversationApiValue(call, context)))] as const,
    cacheShare: complete && total > 0 ? course.calls.reduce((sum, call) => sum + call.tokens!.cache_read, 0) / total * 100 : null };
}
