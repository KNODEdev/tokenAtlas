# Kontrakt dostawcy (U4.7)

Status 05.10.2026 (gałąź `u4.7/provider-registry`): **kontrakt obowiązuje w rejestrze, oknach i czytelnikach
sum.** Adaptery są obiektami w jednym rejestrze, listy dostawców warstw wspólnych z niego wynikają, a test
dostawcy testowego (`src/server/provider-contract.test.ts`) przechodzi bez zmian w kodzie wspólnym. Strażnik
jednego źródła (`src/architecture/single-source.test.ts`) uruchamiamy lokalnie. Miejsca, które nadal wymieniają
dostawców z nazwy, i powód: §4.

Zasada (golden rules §1): dostawcy różnią się plikami, kategoriami tokenów, tożsamością wywołań i odczytami
limitów. Adapter zamienia te różnice na wspólne fakty. Rejestr (ledger), okna i czytelnicy ekranów są wspólni,
a nowy dostawca nie zmienia w nich ani linii.

## 1. Co dostarcza adapter

| Część | Kontrakt | Dziś u istniejących dostawców |
|---|---|---|
| Parser pliku | Czyta oryginał z archiwum przyrostowo (zakładka pliku), zwraca wiersze faktów. Nie wycenia i nie przypisuje kont. | `src/ingest/<dostawca>.ts`, natywny parser `native/tokenatlas-parse`, wpięcie w `src/sync/adapters.ts` |
| Tabela faktów w rodzimych kategoriach | Jeden wiersz na wywołanie. Pola: stabilny `id`, `ts` (z podstawą czasu, gdy jest przybliżony), `model`, rodzime kategorie tokenów bez przeliczania, źródło fizyczne (`store`/`path` w archiwum), tożsamość wywołania z pliku, opcjonalnie sesja, projekt i repozytorium, opcjonalnie kwota podana przez dostawcę. | `claude_events`, `gemini_events`, `grok_events`, `oc_events`, Codex: `events` |
| Przekład na kategorie rejestru | Metody obiektu adaptera (`SubscriptionAccountingAdapter`): `quantities` (wiersz → `TokenQuantities`: `in_uncached`, `in_cache_read`, `in_cache_write_5m`, `in_cache_write_1h`, `in_cache_write_unknown`, `out_total` oraz `out_thinking`, część `out_total`), `eventIdentity` (tożsamość do deduplikacji kopii albo `null` przy niepełnej), opcjonalnie `eligible`, `sessionIdentity`, `source`, `rowRateVendor`, `modelRateVendor`, `valuationVendors`, `modelFamilyKeys`, `modelFamilyRates`, `usageValid`, `preciseTime`, `recordsProvenance`, `product`, `reported`, `windowSession`, `limitHitTable`; `vendor` to dostawca synchronizacji tabeli (GLM: `opencode`). | `src/server/subscription-accounting-adapters.ts`: obiekty w `BUILT_IN`, rejestr `subscriptionAccountingAdapters()`, dopisanie `registerSubscriptionAccountingAdapter` |
| Czytnik odczytów limitu | Zapisuje odczyty do `probe_windows` (`kind`, `limit_group`, `window_minutes`, `resets_at`, `used_percent`/`remaining_percent`, `plan`, `machine` z profilem). Kanoniczny fakt i dziennik zapisuje `persistProbeWindows`. Adapter deklaruje swoje liczniki: `counterKinds`, `defaultCounter`, `defaultMinutes`, `counterIncludes`. | `src/providers/adapters/<dostawca>.ts` → `src/providers/core/probe.ts`; liczniki w obiektach adapterów |
| Ceny | Dostawca stawek (`rateVendor`) w `rate-cards.json`, a w nim stawki per model w kategoriach rejestru. Jeśli prędkość ma znaczenie, flaga `speed` (brak prędkości daje „nieznana” i brak ceny wariantu `api_actual`). | `rate-cards.json`, `src/server/pricing.ts` |

Adapter **nie** dostarcza: przypisania konta (konto zawsze wynika z okresów `account_periods` dla źródła),
wyceny, sum dni ani okien. Robi to warstwa wspólna.

### Cykl życia licznika (25.10.2026)

`window-lifecycle.ts` rozdziela aktywację, powrót do wcześniejszego licznika, zmianę wielkości limitu
i koniec uprawnienia wspólnie dla wszystkich dostawców, także Codex. Adapter może udostępnić
`windowMeterPlan(plan)`: kanoniczną tożsamość niezależnego licznika powiązanego z planem. Obecnie
robi to Claude; dodanie takiej reguły innemu dostawcy nie zmienia wspólnego algorytmu. Sama nowa
nazwa planu nie dowodzi nowego licznika. Przy braku dowodu pozostaje zaobserwowany poziom zużycia.

Odczyty zachowują plan źródłowy i opcjonalne `allowance`/`used` w `limit_window_inputs.meter_evidence`
(0094). Zmiana dodatniego mianownika przy tym samym resecie kończy porównanie i zaczyna częściowe
od pierwszego nowego odczytu; nie tworzy zera ani dodatkowego resetu. Potwierdzona aktywacja
niezależnego licznika może zaczynać się od zera. Powrót do wcześniejszego licznika zachowuje jego
procent i datę resetu. W rejestrze pozostają osobno reset dostawcy, rzeczywisty koniec oraz przedziały
aktywności. Rekonstrukcja okien bez odczytów korzysta z tych samych datowanych uprawnień i nie
wypełnia przerw po wygaśnięciu; rzeczywisty późniejszy odczyt jest zachowany.

Zmiany zapisuje istniejący producent tła, a wykresy, sumy i rozliczenia czytają gotowe fakty.
[Zakres, testy i stan aktywacji](verification/unified-window-lifecycle-2026-10-25.md).

## 2. Warstwy wspólne (bez zmian dla nowego dostawcy)

- Czas do pierwszego tokena: adapter w `src/providers/first-token` potwierdza znaczenie źródła,
  parsuje zakończone tury i korzysta ze wspólnego resolvera kont. `first-token-producer.ts`,
  `db/first-token.ts` i `first-token-read.ts` wspólnie obsługują historię, kolejkę zmian, kopie,
  histogramy i odczyt. Mediana/P90 powstają z połączonych pomiarów, a brak dowodu pozostaje
  brakiem. [Kontrakt i weryfikacja](verification/first-token-2026-10-25.md).

- Rejestr: `src/db/usage-ledger*.ts`, `src/server/usage-ledger-producer.ts` (fakty → wycenione zdarzenia →
  sumy dni i godzin).
- Okna: `src/server/limit-window-producer.ts` (odczyty limitu → okna liczników),
  `src/server/window-usage*.ts` (sumy okien z rejestru).
- Czytelnicy ekranów: `src/server/ledger-sums.ts` (sumy dni) i API odczytu `src/server/window-usage.ts`
  (sumy okien). Strażnik pilnuje, że inne pliki nie czytają faktów i nie sumują tokenów.

## 3. Strażnik jednego źródła

`src/architecture/single-source-allowlist.ts` to jedyna lista plików, które mogą czytać tabele faktów
i rejestrów albo sumować tokeny i kwoty w SQL. Każdy wpis ma rodzaj (register, producer, ingest, detail,
maintenance, legacy) i jednozdaniowe uzasadnienie. Liczby odczytów i sum są dokładne, więc każdy nowy odczyt
w pliku z listy to widoczna zmiana tej listy. Wpisy `legacy` to sumy ekranów, które jeszcze trzeba przenieść
do rejestru.

## 4. Gdzie kod nadal wymienia dostawców z nazwy

Listy dostawców rejestru, okien, świeżości odczytów, cen, zużycia subskrypcji, postępu tła, śledzonych tabel
faktów, pomiarów ręcznych i strażnika wynikają z rejestru adapterów (`usageLedgerProviderIds`,
`usageProviderIds`, `subscriptionAccountingAdapters`). Gałęzie po nazwie dostawcy w rejestrze (producent,
odczyt zdarzeń, `ledger-sums.ts` z czytelnikami U4.7), w oknach limitu i w sesjach sum okien są metodami
adapterów. Zostają:

- **Codex** (`"codex"` w `ledger-sums.ts`, `window-usage.ts`, `limit-window-producer.ts`, `read-freshness.ts`,
  `subscription-usage.ts`, `subscription-preparation.ts`): Codex ma własny rejestr cen (`codex_price_ledger_*`)
  i odczyty z transkryptów, nie jest dostawcą wspólnego rejestru. Nowy dostawca idzie ścieżką wspólną.
- **Źródła przedziałów sum okien z konfiguracji** (`window-usage.ts`: wskaźnik Claude i jego okna deklarowane,
  modele zakresu Claude, szczegół okna Claude; wskaźnik Grok, okna kroczące i zakotwiczone Grok i Gemini):
  przedziały liczone z plików `claude-gauge.json` / `grok-gauge.json` i z odczytów konkretnego dostawcy. Są
  dodatkowe względem okien z odczytów limitu, więc nie blokują nowego dostawcy; przeniesienie do adaptera
  wymaga haka z dostępem do konfiguracji.
- **Ekrany i trasy API** (`api.ts`: parametry `vendor` = `claude`/`codex`/`both`/`all`, karty dostawców,
  możliwości sond), `app-activity.ts` (typ `ActivityProviderId` wspólny z interfejsem), interfejs `src/web`:
  warstwa prezentacji, poza zakresem kryterium 8.
- **Synchronizacja i parsery** (`src/sync`, `src/ingest`, `USAGE_VENDOR_IDS`): wpięcie parsera nowego
  dostawcy to część adaptera (§1, wiersz „Parser pliku”).
- **Migracje 0046/0060**: częściowe indeksy faktów per wbudowany dostawca. Nie blokują nowego dostawcy:
  producent rejestru tworzy brakujące indeksy dostawcy przed pierwszym krokiem po wypełnieniu.

## 5. Test dostawcy testowego

`src/server/provider-contract.test.ts`: dostawca `testprovider` z tabelą `test_events` w rodzimych kategoriach
(`prompt`, `cached`, `completion`), adapterem rejestrowanym tylko w teście, odczytami limitu w `probe_windows`
i stawkami w karcie testowej. Test sprawdza: fakty → sumy dni z `readLedgerSums` równe sumom policzonym ręcznie
z wierszy, odczyty limitu → okna (`readLimitWindows`), okna → sumy okien z `readWindowSums` równe wywołaniom
wewnątrz okna. Poza testem żaden plik nie zna tego dostawcy.

## 6. Ekrany okien (zapamiętane odpowiedzi)

Ekrany, które czyta przełączenie subskrypcji lub okna (pasek okien, rozbicie okna, rozliczenie okien zakresu
dni, limit Claude), są jednym modułem dla wszystkich dostawców. Nie ma tabel, reguł unieważniania ani kolejek
per dostawca.

- **Wspólne** (bez zmian dla nowego dostawcy): rejestr ekranów `src/server/window-screens.ts`, przechowywanie
  i aktualność `src/db/window-answers.ts` (tabela `window_answers`, znaczniki `window_answer_marks`), liczenie
  poza wątkiem HTTP, publikacja przez zapisującego w tle, przeliczanie w tle i odczyt (`src/server/data-read.ts`).
  Znaczniki dopisują ci sami zapisujący, którzy brudzą sumy okien (`markWindowUsageDirty`: rejestr, segmentacja
  okien, okresy kont, ceny), producent sum okien przy publikacji wiersza i przeliczenie planu okna. Zmiana
  rejestru wycen (godziny, dni) oznacza odpowiedzi tylko kont, do których należą jej źródła i tożsamości sesji w tym
  czasie (okresy kont; `ledger-answer-owners.ts`); gdy tego nie da się ustalić — wszystkich kont dostawcy. Odpowiedź jest
  aktualna, dopóki żaden późniejszy znacznik nie nachodzi na jej zakres (dostawca, konto, chwile); nieaktualna
  zostaje na ekranie, a następczyni liczy się w tle.
- **Wpis ekranu** w rejestrze: trasa, `scope` (dostawca, konto i zakres chwil odpowiedzi, `family` — to samo
  żądanie bez ruchomego końca; klucz to samo żądanie), `clock` (wiek i odliczania prezentowane przy odczycie),
  `produce` i `prefill` (żądania, które interfejs wysyła przy pierwszym otwarciu, dla każdego konta i okna, wyprowadzone
  tymi samymi funkcjami klienta z zapisanych odpowiedzi paska okien).
- **Wypełnianie z góry** (`data-read.ts`): gdy `limit_windows` i `window_usage` są aktualne, kolejka tych samych
  workerów liczy odpowiedzi brakujące albo nieaktualne przez znacznik lub konfigurację, za każdym innym zadaniem,
  najwyżej na wszystkich workerach poza jednym (trzy workery: dwie odpowiedzi naraz, trzeci wolny dla żądań):
  najpierw paski okien, potem bieżące okna, potem zamknięte od najnowszych. Żądanie z ruchomym końcem liczy się tylko, gdy jego rodzina nie ma żadnej odpowiedzi. Przebieg listy
  bez obliczeń kończy pracę do następnego znacznika, zmiany konfiguracji albo dnia.
- **Adapter dostawcy** dostarcza tylko `produce`: funkcję budującą odpowiedź jednego żądania ze wspólnych
  rejestrów (rejestr wycen, `limit_windows`, `window_usage`, odczyty limitu). Producent czyta sumy rejestru, nie wywołania: odpowiedź okna Codex to sumy godzin
  (`codex_price_ledger_aggregates`, ziarno `hour`) i z wywołań tylko kawałki godzin przeciętych przez granice okna, sesji,
  dnia, okresów konta i spalania (`readCodexLedgerHourSums`, `readCodexLedgerPieceSums`); zakres chwil w każdym odczycie
  rejestru Codex (`readCodexLedgerGroups`) tak samo: pełne godziny z sum, krańce z wywołań. Codex: `/api/cycle-breakdown`,
  `/api/codex-accounting`, `/api/usage-series`; Claude, Gemini, Grok, GLM: `/api/subscription-accounting`;
  wszyscy: `/api/windows`; Claude: `/api/claude-limit`. Dostawca rejestru wspólnego bierze wpisy wspólne bez
  zmian (identyfikator dostawcy z adaptera, konto z okresów).
