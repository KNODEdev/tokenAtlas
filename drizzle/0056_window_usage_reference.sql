-- Window usage (plan U1.4): the reference-day variant of a window's cycle sums, valued at the rates of the
-- configured reference day (the day screens compare prices at by default). JSON {day, fingerprint, cycle}; the
-- fingerprint names the effective rates, so a request whose day has the same rates reads it. NULL until the
-- producer has valued the window (or while the reference valuation is being prepared).
ALTER TABLE window_usage ADD COLUMN reference TEXT;
