CREATE TRIGGER codex_context_final_scope_insert AFTER INSERT ON codex_context_aggregates WHEN NEW.grain='day' BEGIN
 INSERT OR IGNORE INTO codex_context_final_pending SELECT w.account,w.counter,w.window_id FROM limit_windows w
 JOIN window_usage u USING(provider,account,counter,window_id)
 WHERE w.provider='codex' AND julianday(w.start_ts)<julianday(NEW.day)+2 AND julianday(w.end_ts)>julianday(NEW.day)-1
 AND EXISTS(SELECT 1 FROM json_each(json_extract(u.rail,'$.by_model')) m WHERE json_extract(m.value,'$.model') IS (SELECT model FROM codex_price_ledger_dims WHERE id=NEW.dim_id));
 END;
--> statement-breakpoint
CREATE TRIGGER codex_context_final_scope_update AFTER UPDATE ON codex_context_aggregates WHEN NEW.grain='day' BEGIN
 INSERT OR IGNORE INTO codex_context_final_pending SELECT w.account,w.counter,w.window_id FROM limit_windows w
 JOIN window_usage u USING(provider,account,counter,window_id)
 WHERE w.provider='codex' AND julianday(w.start_ts)<julianday(NEW.day)+2 AND julianday(w.end_ts)>julianday(NEW.day)-1
 AND EXISTS(SELECT 1 FROM json_each(json_extract(u.rail,'$.by_model')) m WHERE json_extract(m.value,'$.model') IS (SELECT model FROM codex_price_ledger_dims WHERE id=NEW.dim_id));
 END;
--> statement-breakpoint
CREATE TRIGGER codex_context_final_scope_delete AFTER DELETE ON codex_context_aggregates WHEN OLD.grain='day' BEGIN
 INSERT OR IGNORE INTO codex_context_final_pending SELECT w.account,w.counter,w.window_id FROM limit_windows w
 JOIN window_usage u USING(provider,account,counter,window_id)
 WHERE w.provider='codex' AND julianday(w.start_ts)<julianday(OLD.day)+2 AND julianday(w.end_ts)>julianday(OLD.day)-1
 AND EXISTS(SELECT 1 FROM json_each(json_extract(u.rail,'$.by_model')) m WHERE json_extract(m.value,'$.model') IS (SELECT model FROM codex_price_ledger_dims WHERE id=OLD.dim_id));
 END;
