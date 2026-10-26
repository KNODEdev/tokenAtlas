# tokenAtlas monitor

Natywny widget abonamentów Codex/Claude z kilkoma niezależnymi wykresami.
Wykresy są jeden pod drugim w oknie szerokości 360 px. Wysokość dopasowuje się
do rzeczywistej zawartości pierwszych dwóch kart i dostępnego pulpitu. Rust, egui,
renderer programowy i softbuffer; bez przeglądarki i OpenGL.

## Wspólne dane

Historia i dostępne sumy pochodzą z opublikowanego rejestru tokenAtlas: `limit_windows`,
`limit_window_state` i dostępne sumy `window_usage.rail`. Abonamenty pochodzą
z AccountsV2 w Settings. Historia na wykresie jest historią tego samego okna
co w tokenAtlas. Tokeny/API pojawiają się tylko, gdy wspólny rejestr je zawiera;
nie są odtwarzane z procentu. Niepełna wycena ma oznaczenie dolnej granicy.

Monitor wymaga istniejącej instalacji tokenAtlas i Bun w PATH (lub
`TOKENATLAS_BUN_BIN`). Krótki proces `scripts/dev/monitor-locations.ts` używa
wspólnych `activeDatabasePath`, `configFile` i `readAccountsV2`, po czym kończy
się. Nie uruchamia serwera, importera, migracji ani obliczeń historii.
Połączenie SQLite jest tylko do odczytu, z `query_only`, 1 MiB cache i bez mmap.

Gdy pełna aplikacja działa, widget wykrywa zmiany SQLite co 5 sekund i nie odpytuje
dostawców. Gdy jej proces kończy się, uruchamia krótkotrwały istniejący kolektor
`scripts/usage-monitor.ts` dla wybranych, zweryfikowanych kont Codex/Claude.
Domyślnie mierzy co 20 minut (5–120 w ustawieniach); odświeżenie wymusza próbę.
Kolektor zapisuje te same kanoniczne fakty do wspólnego archiwum `gauges`.
Pełna aplikacja zaimportuje je zwykłą drogą po uruchomieniu. Oddzielny plik
dziennika zapobiega równoczesnemu dopisywaniu do jednego pliku; przejęcie zbierania
nie jest atomową blokadą wywołań sieciowych — ostatni odczyt może kończyć się podczas
startu pełnej aplikacji. Kolektor sprawdza ją przed kolejnym kontem.

Świeży procent pojawia się po potwierdzonym lokalnym zapisie całej obserwacji
do archiwum. Trwały transport zachowuje niedostarczone fakty i ich oryginalne ID;
jedna odtwarzalna projekcja bieżącej obserwacji na konto nie jest historią wykresu.
Przy niedostępnym archiwum zachowany jest poprzedni pomiar i widoczny błąd.
Świeży pomiar nie odtwarza tokenów/API ani początku okna z samego procentu.
Spadek/reset odcina stare sumy i podstawę prognozy. Nie ma drugiego prywatnego
rejestru historii; stary prywatny dziennik pozostaje zachowany i nie jest wczytywany.
Krótkotrwały Bun korzysta z istniejących adapterów i lokalnych profili logowania;
nie uruchamia serwera ani importera. Zamknięcie widgetu kończy jego procesy potomne.

W pamięci pozostaje najwyżej 600 punktów na panel, maksymalnie osiem paneli.
Bufor nowych, potwierdzonych pomiarów ma łącznie limit 4800 punktów.
Powtórzony wybór tego samego konta/okna współdzieli odczyt w danym odświeżeniu. Odczyt źródła
ma limit 4 MiB/40 000 punktów; przekroczenie jest jawnym błędem. Spadki są
klasyfikowane przed redukcją. Braki odczytów nie rozcinają linii: kolejne zapisane
punkty są łączone bez dopisywania pomiarów.
Niegotowe okno daje błąd/brak wartości, nigdy pozorne zero.

Każdy panel pokazuje procent pozostałego limitu, czas do resetu/końca okna,
tempo w %/h oraz przybliżony czas do 100%. Średnie tempo bierze znany początek
okna albo dwa rzeczywiste odczyty bieżącego segmentu. Podstawa powstaje przed
redukcją punktów. Mnożnik względem czasu okna wymaga znanej bazy; ETA dodatkowo
wymaga świeżego odczytu, dodatniego tempa i trwającego okna. „Po oknie” oznacza,
że liniowa prognoza wykracza poza jego koniec. Pełne daty/założenia są w dymkach.

## Uruchomienie

Windows: `dist/tokenatlas-monitor.exe`. W menu „···” zaznacz abonamenty.
Przycisk „+” dodaje wykres; „×” na karcie usuwa go. Każda karta ma własny wybór
konta i licznika, również dla dwóch okien tego samego abonamentu. Dalsze karty
są przewijane pionowo; pierwsze dwie wymagają przewijania tylko, gdy zabraknie miejsca
na pulpicie. Ustawienia zachowują wybory,
motyw, interwał 5–120 minut i „zawsze na wierzchu”. Domyślny interwał to 20 min.
Własny nagłówek pozwala przeciągnąć, zminimalizować i zamknąć okno bez systemowego paska.
Minimalizacja chowa okno do zasobnika i usuwa je z paska zadań. Kliknięcie ikony
przywraca okno; menu ikony ma „pokaż tokenAtlas” i „zakończ”. Przy niedostępnym
zasobniku pozostaje zwykła minimalizacja, z błędem w dymku. Linux wymaga aktywnego
hosta StatusNotifier; obsługa tray używa KSNI, bez GTK.
Interfejs rysuje na zdarzenia; zegar budzi się raz na minutę.
Zamknięcie kończy program, bez usługi i autostartu.

Instalacja jest wykrywana w nadrzędnych katalogach EXE lub bieżącego folderu.
Gdy plik został przeniesiony, użyj `--atlas-root PATH`. Lokalny folder monitora
przechowuje jedynie konfigurację i blokadę pojedynczej instancji; wybierają go
`--data-dir`, `TOKENATLAS_MONITOR_HOME` lub systemowy `directories::ProjectDirs`.
Ścieżka głównej bazy zawsze pochodzi z Settings tokenAtlas.

- `--list-profiles`: abonamenty z Settings i ich identyfikatory `dostawca:id`.
- `--select ID`: wybór konta, opcja powtarzalna.
- `--once`: odczyt skonfigurowanych paneli, liczby punktów i dostępność prognoz, bez GUI.
- `--theme light|dark`: motyw.
- `--exit-after N`: ograniczona próba widocznego okna.
- `--demo --data-dir PATH`: izolowane sztuczne dane; ten tryb ma własne fixture.
- `--demo --data-dir PATH --preview IMAGE.png`: podgląd przez ten sam rasteryzator.

`measure.ps1 -AccountIds ... -ReportPath REPORT.json -Seconds 90` mierzy widoczne
okno, CPU, pamięć, odpowiedzi okna i próbkowany szczyt potomków. Po próbie program
sam się zamyka; `-KeepOpen` pozostawia zwykłe widoczne okno do dalszej pracy.
`-Demo -HiddenDemo -DataDirectory PATH` jest osobną próbą ukrytego
demo, która nie stanowi dowodu zachowania rzeczywistych danych i widocznego UI.

## Budowanie i testy

Stabilny Rust, osobny natywny build dla każdego systemu. SQLite jest dołączony.
Skrypty ograniczają kompilację do dwóch zadań i obniżają priorytet.

Windows: MSVC Build Tools C++ i Windows SDK, następnie `./native/tokenatlas-monitor/package.ps1`.
macOS: Xcode Command Line Tools, następnie `sh native/tokenatlas-monitor/package.sh`.
Linux: kompilator C, pkg-config i nagłówki X11/Wayland, następnie ten sam skrypt.
Mac/Linux mają kod i skrypty, lecz nie były tutaj uruchamiane. Pakiety nie są podpisane
ani opublikowane. Nie używaj `target-cpu=native`.

Ikona pochodzi z zatwierdzonego `landing/favicon-mark.svg`. Windows ma wielorozmiarową
ikonę w zasobach EXE, ikonę okna/paska zadań oraz znak w nagłówku. Pakiet macOS
zawiera ICNS i wpis `CFBundleIconFile`. Linux otrzymuje PNG i ikonę okna X11;
ikona launchera Wayland wymaga jeszcze instalacji pliku `.desktop` i zgodnego app ID.
Zasoby PNG/ICO/ICNS są zapisane w `assets/`; opcjonalne odtworzenie wymaga Node i sharp:
`node native/tokenatlas-monitor/generate-icons.mjs`. Przy sharp poza projektem ustaw
`TOKENATLAS_SHARP_MODULE` na jego URL modułu. Zwykły build nie wymaga Node ani sharp.

```sh
cargo test --locked --jobs 2 --manifest-path native/tokenatlas-monitor/Cargo.toml
cargo clippy --locked --jobs 2 --manifest-path native/tokenatlas-monitor/Cargo.toml --all-targets -- -D warnings
```

Kolory/skala pochodzą z tokenów CSS tokenAtlas; lokalne IBM Plex Sans/Mono
z licencjami w paczce. Dokładne daty, źródło i błędy są w dymkach.

