-- The account periods drawer and vendor discovery read each account's newest reading that names a vendor account
-- (vendor-discovery.ts `rememberedVendorAccounts`): a json_extract over every reading, 0.3-3 s, also on the HTTP
-- thread at each discovery refresh. This index holds exactly those readings, in the order the read needs.
CREATE INDEX IF NOT EXISTS probe_windows_vendor_account ON probe_windows(provider, subject, ts)
  WHERE json_valid(extra) AND json_extract(extra, '$.vendor_account') IS NOT NULL;
