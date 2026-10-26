import { expect, test } from "bun:test";
import { setupDeclarations } from "./Setup";

test("wizard keeps an unowned physical source on a plain re-save", () => {
  const payload = setupDeclarations([{ id:"", editedId:"", vendor:"codex", machine:"PC", login:"user",
    home:"${ARCHIVE}/codex/PC-user", source_home:"C:/Users/user/.codex", found_in:"declared",
    is_this_machine:true, merged_from_login:false, include:true }]);
  expect(payload.subscriptions).toEqual([]);
  expect(payload.sources).toEqual([{vendor:"codex",machine:"PC",login:"user",home:"${ARCHIVE}/codex/PC-user",
    source_home:"C:/Users/user/.codex"}]);
});

test("observed owner shown for a source is not promoted into subscription metadata", () => {
  const payload = setupDeclarations([{ id:"observed-seat", editedId:"observed-seat", vendor:"codex", machine:"PC", login:"user",
    home:"${ARCHIVE}/codex/PC-user", found_in:"declared", is_this_machine:true,
    merged_from_login:false, include:true }]);
  expect(payload.sources).toHaveLength(1);
  expect(payload.subscriptions).toEqual([]);
});
