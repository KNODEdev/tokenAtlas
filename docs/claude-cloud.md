# Claude Code cloud history

tokenAtlas imports Claude Code sessions that run in Anthropic's cloud. These sessions do not automatically appear in the local CLI transcript folders. Provider limit percentages can include cloud traffic even when tokenAtlas has not imported its history.

## Sign-in and trusted device

The importer needs valid credentials from the official Claude Code CLI and a **trusted-device credential for the same local Claude profile**. A browser sign-in alone does not place this credential in the CLI profile. “Trusted device” is Claude's device verification feature, not a requirement to disable security controls or provide tokenAtlas with a password.

If import reports an expired sign-in, rejected refresh or missing trusted device:

1. Open the official Claude Code CLI using the affected profile and run `/login`.
2. Complete the device verification when prompted. Review the **Trusted devices** section in your Claude account settings. See [Claude's Trusted Devices documentation](https://code.claude.com/docs/en/remote-control#trusted-devices).
3. In tokenAtlas, keep cloud import enabled under **Settings → Computers and data → Advanced configuration**. It retries at the saved interval, normally 30 minutes. Confirm that the next run finishes without errors.

Never paste access tokens, trusted-device credentials or credential files into tokenAtlas settings, public issues or screenshots. The importer uses the local CLI credentials in memory for provider GET requests; it does not add them to the source archive or Git repository.

The current integration reads provider session endpoints whose format can change. HTTP 401/403, a failed request or an unreadable response means import failed; it is not evidence of zero cloud usage. A generic HTTP 403 does not by itself prove a missing trusted device.

## Warnings and measurement coverage

An import failure appears as **Claude cloud history incomplete** in the application status. Expand its events and choose **Cloud import details** for the explanation and last import errors. The same drawer is available beside the cloud import interval in Settings. Status refreshes periodically; a later successful run clears the warning.

Failed imports preserve previously archived history. Until a successful retry, new cloud traffic may be missing from token counts, costs, projects and comparisons while provider percentages already include it. Missing history is not zero usage. Other local sources can continue importing independently.

Per-call input and cache counts come from the cloud event records. Those records do not contain final per-call output; completed-turn output comes from differences in the provider's cumulative `modelUsage` totals for each model. Output for an unfinished turn remains unmeasured. Cloud originals take precedence over matching teleported copies to avoid counting the same traffic twice. These measurements are analytics, not provider invoices.

## Po polsku

Import historii Claude Code z chmury wymaga aktualnego logowania oraz poświadczenia **zaufanego urządzenia (Trusted device)** w tym samym lokalnym profilu Claude. Samo zalogowanie do strony nie wystarcza. Uruchom oficjalne Claude Code CLI z właściwym profilem, wykonaj `/login` i ukończ weryfikację urządzenia, jeśli zostaniesz o nią poproszony. Nie kopiuj żadnych tokenów do tokenAtlas ani zgłoszeń.

Błąd jest widoczny w statusie jako **Niepełna historia Claude z chmury**. W zdarzeniach wybierz **Szczegóły importu chmury**. Aplikacja ponawia odczyt w zapisanym odstępie. Do udanego importu nowe tokeny, koszty i sumy projektów mogą być niepełne, choć procent limitu Claude już zawiera ten ruch. Wcześniej zapisane dane pozostają zachowane.
