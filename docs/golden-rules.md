# Złote zasady tokenAtlas

Ustalenia z 16 września 2026. Dokument obowiązuje przy projektowaniu, implementacji i ocenie zmian w aplikacji.

**Jedno wspólne źródło policzonych danych, aktualizowane przyrostowo w tle. Wszystkie moduły korzystają z tych samych wyników. Restart i otwarcie ekranu nie uruchamiają ponownego liczenia historii.**

Stan na 03.10.2026: obecny kod nie spełnia §5, §9 i §13 dla ekranów Codex i koordynacji zapisów; pomiary i plan dojścia są w [pipeline-review-plan-2026-10-03.md](pipeline-review-plan-2026-10-03.md).

To wymagania architektury, a nie deklaracja, że obecny kod już je wszystkie spełnia. Zgodność potwierdzamy pomiarami i testami. Starsze opisy implementacji nie uzasadniają odstępstwa od tych zasad. Późniejsze jawne ustalenia z użytkownikiem aktualizują ten dokument. Obowiązują również ograniczenia interfejsu zapisane w [AGENTS.md](../AGENTS.md).

## 1. Jeden wspólny rejestr wyliczeń

```text
Nowe lub poprawione dane źródłowe
                ↓
Wspólne przetwarzanie przyrostowe w tle
                ↓
Trwałe wyceny, sumy i stan ich aktualności
                ↓
Przegląd · Zużycie · Pojemność · Historia · Porównania · Eksporty
```

Wspólne źródło oznacza jeden obowiązujący kontrakt danych i zasad obliczeń. Może składać się z kilku powiązanych tabel w bazie. Nie wymaga jednej wielkiej tabeli, jednego pliku JSON ani jednego procesu wykonującego wszystko po kolei.

Rejestr zawiera:

- rozpoznane zdarzenia, ich pochodzenie i historyczne przypisanie do konta;
- wyceny z wersją zastosowanych reguł;
- gotowe sumy dla potrzebnych kont, modeli, projektów, dni, cykli i przedziałów pomiarowych;
- odczyty procentów oraz sumy odpowiadające ich czasom;
- rewizje zależności, postęp przetwarzania i kolejkę niedokończonych prac.

Nowa funkcja rozszerza ten rejestr o brakujący wynik. Nie tworzy własnej konkurencyjnej wyceny, deduplikacji ani interpretacji kont. Adaptery dostawców zachowują ich rzeczywiste różnice, ale publikują dane zgodnie ze wspólnym kontraktem.

## 2. Dane źródłowe, wyliczenia i cache mają różne role

Uściślenie z 19 września 2026: **foldery wejściowe → wybrany wspólny folder archiwum źródeł → lokalna baza wyników na każdym komputerze**. Najpierw zabezpieczamy źródło w archiwum, dopiero potem je przetwarzamy. OneDrive jest jedną z możliwych lokalizacji, nie wymaganiem aplikacji. Usunięcie oryginału przez dostawcę nie usuwa zachowanej historii.

Ostateczne ustalenie z 19 września 2026: **jedna rosnąca rozmowa ma jeden zachowany plik w folderze dostawcy/komputera; bez `.source-versions` i osobnego magazynu kopii**. Archiwum przechowuje źródła, oryginalne obserwacje i deklaracje potrzebne do interpretacji oraz pochodzenie tych danych. Bazy wynikowe, rejestr plików, kolejka zmian, snapshoty indeksu, cache odpowiedzi i punkty wznowienia pozostają na komputerze. Wspólny rejestr wyliczeń oznacza wspólne wyniki dla modułów **danego komputera**, a nie współdzielony plik SQLite w chmurze. Wiążący plan, aktualny stan i kolejność bezpiecznego wycofania obecnego magazynu: [Archiwum źródeł i obliczenia przyrostowe](source-archive-plan-2026-09-19.md).

Ustawienia rozdzielają folder archiwum, folder lokalnej bazy i folder tymczasowy. Temp służy wyłącznie odtwarzalnym plikom roboczym; ukończone wyniki, punkty wznowienia i dowody z niedokończonych operacji nie są temp. Szczegóły bieżącego podziału: [Lokalizacje danych](storage-locations.md).

| Warstwa | Rola | Trwałość |
|---|---|---|
| Źródła i oryginalne obserwacje | Dowody pozwalające sprawdzić lub odtworzyć wynik | Zachowane zgodnie z polityką archiwum |
| Rozpoznane fakty i wyceny | Jedna interpretacja zdarzeń i kosztów | Zapisane w bazie, wersjonowane |
| Wspólne sumy i pomiary | Podstawowe dane wszystkich modułów | Zapisane w bazie, aktualizowane przyrostowo |
| Cache odpowiedzi i pamięć procesu | Dodatkowe przyspieszenie prezentacji | Możliwe do usunięcia bez odbudowy historii |

Lista wszystkich wycenionych zdarzeń zapisana jako JSON nie zastępuje gotowej sumy. Jej ponowne dekodowanie, sortowanie, deduplikowanie i sumowanie nadal jest pracą zależną od rozmiaru historii.

Wyczyszczenie pomocniczego cache nie może usuwać obowiązujących wycen i sum. Zamknięcie programu nie może powodować utraty ukończonej pracy. Wynik uznajemy za trwale opublikowany dopiero po jego zapisie, nie po umieszczeniu go w pamięci.

Archiwum odbudowy obejmuje zachowane dane zużycia, dzienniki odczytów oraz potrzebne historyczne deklaracje ustawień, przypisań i ręcznych pomiarów. Docelowo odbudowa czyta zwykłe pliki archiwum bez dostępu do pierwotnych aplikacji i bez magazynu wersji. Obecność folderu, także na OneDrive, nie dowodzi kompletności: sprawdzamy treść i możliwość odtworzenia. Dopisanie uzupełnia ten sam plik. Usunięcie lub skrócenie oryginału nie może po cichu skasować zachowanej historii; niejednoznaczne rozbieżności wymagają jawnego zabezpieczenia konfliktu, bez automatycznego podwójnego naliczania.

Lokalizację archiwum wybiera użytkownik przy pierwszym uruchomieniu; OneDrive ani inna chmura nie są wymagane. Późniejsze przeniesienie kopiuje i weryfikuje dane, zachowuje nowe zapisy oraz przełącza lokalizację z możliwością wznowienia. Tożsamość archiwum i źródeł nie zależy od ścieżki. Przeniesienie tego samego archiwum nie tworzy duplikatów, nie usuwa ustawień/ręcznych pomiarów i nie uruchamia ponownej wyceny historii. Lokalna baza robocza jest oddzielna od archiwum; jej gotowe wyniki pozostają dostępne przy odłączeniu miejsca archiwizacji.

Reset wyliczeń zachowuje archiwum, ustawienia i oryginalne odczyty procentowe wraz z czasem i pochodzeniem. Odczyt procentowy jest trwałym faktem źródłowym, a nie wynikiem do skasowania i przeliczenia. Odtwarzane mogą być jego brakujące reprezentacje robocze oraz zależne obliczenia; odtworzenie nie zmienia wartości ani czasu oryginału. Wybrany okres jest zamieniany na trwałe daty oraz rozszerzany o rzeczywiste zależności, np. przecinające go sesje i cykle. Brak pliku nie oznacza zerowego zużycia ani uprawnienia do usunięcia wcześniejszych, potwierdzonych danych. Pełnej odbudowy nie uznajemy za ukończoną, jeśli część wymaganych źródeł była niedostępna i nie została odtworzona.

## 3. Zmiana ma aktualizować tylko swoje zależności

Każdy zapisany wynik ma określone: źródła, zakres, konto, licznik, wymagane wymiary i wersje reguł. Zmiana oznacza do aktualizacji wyłącznie zależne wyniki.

| Zdarzenie | Dozwolona praca |
|---|---|
| Restart bez zmian źródeł i reguł | Odczyt gotowych wyników, wznowienie niedokończonych zadań |
| Przeniesienie tego samego archiwum | Weryfikacja kopii i aktualizacja lokalizacji, bez ponownej wyceny historii |
| Odświeżenie strony lub zmiana zakładki | Odczyt i lekka prezentacja danych |
| Nowe wywołanie | Rozpoznanie i wycena tego wywołania, aktualizacja właściwych sum |
| Ponownie dostarczona identyczna kopia | Rozpoznanie duplikatu, bez zmiany sum |
| Korekta starego wpisu | Korekta wkładu starej i nowej wersji oraz ich zależności |
| Nowy lub poprawiony % | Aktualizacja odpowiedniego pomiaru i zależnych porównań |
| Zmiana historycznego przypisania konta | Dotknięte źródła, konta i okresy |
| Zmiana ceny modelu od określonej daty | Dotknięty model, okres i zależne wyceny |
| Pierwszy import, jawna odbudowa lub migracja zmieniająca reguły | Zadeklarowany zakres przygotowania w tle, z trwałym postępem |

Sama zmiana czasu, etykiety, motywu, daty sprawdzenia pliku albo rewizji niezwiązanego dostawcy nie unieważnia wycen historii. Identyczny ponowny zapis nie zwiększa rewizji faktów. Zmiana schematu unieważnia tylko wyniki, których znaczenie lub format rzeczywiście zmienia.

Brak wpisu w cache, niezgodność ogólnego znacznika lub brak metadanych zakresu nie są poleceniem automatycznej pełnej odbudowy. Taki stan wymaga jawnego rozpoznania przyczyny i ograniczonej naprawy z widocznym statusem.

## 4. Import jest przyrostowy i powtarzalny

Importer pamięta tożsamość źródła, wersję parsera, punkt wznowienia oraz informacje pozwalające wykryć rzeczywistą zmianę. Nie czyta ponownie całego archiwum przy każdym uruchomieniu ani żądaniu ekranu.

Parser może ponownie odczytać część sesji potrzebną do odzyskania kontekstu, np. trybu rozliczenia. Zakres tej pracy musi wynikać z konkretnej zmiany. Przesunięcie w pliku bez kontekstu nie wystarcza, jeżeli prowadziłoby do innego wyniku.

Spóźnione dane aktualizują dzień zdarzenia, a nie dzień importu. Usunięcia i korekty są obsługiwane jawnie. Ponowienie tej samej operacji daje ten sam wynik: bez podwójnych tokenów i bez mnożenia prac do wykonania.

## 5. Ekrany korzystają z gotowych danych

Zwykły odczyt ekranu może filtrować, sumować gotowe wiersze, dzielić liczby, sortować niewielki wynik i formatować prezentację. Nie uruchamia importu, wyceny ani przejścia przez wszystkie źródłowe zdarzenia.

Zakres 7, 31 czy 365 dni nie tworzy nowej wyceny tych samych wywołań. Pełny cykl ma stabilną tożsamość niezależną od zakresu ekranu. Wykres długiej historii pobiera podsumowania o odpowiedniej rozdzielczości, zamiast wysyłać wszystkie zdarzenia do przeglądarki.

Gdy nowa funkcja potrzebuje jeszcze nieprzygotowanych danych, przygotowanie trafia do niezależnego zadania w tle. Odczyt zwraca dostępny wynik z jego aktualnością albo jawny stan przygotowania. Nie czeka w kolejce za wielominutową odbudową historii. Powtarzane odczyty nie tworzą duplikatów zadania.

Szczegóły i audyt mogą odczytywać indeksowane zdarzenia w ograniczonym zakresie lub stronicowanej liście. To nie jest uprawnienie do uruchamiania pełnego przeliczenia z poziomu zwykłego widoku.

## 6. Nowy procent oznacza prostą arytmetykę

Dla tej samej subskrypcji i tego samego licznika, przy braku resetu między odczytami:

```text
przyrost procentu = procent końcowy − procent początkowy
zużycie w przedziale = suma końcowa − suma początkowa
wartość 1% = zużycie w przedziale / przyrost procentu
szacowana wartość 100% = wartość 1% × 100
```

Sumy muszą dotyczyć dokładnych chwil odczytów i tej samej podstawy wyceny. Mogą być przechowywane narastająco w obrębie cyklu albo jako równoważne, gotowe sumy przedziałów. Odczyt % zapisujemy niezależnie od tego, czy odpowiedni ruch został już w całości zaimportowany; późniejszy import aktualizuje zależny wynik.

Dla przygotowanego przedziału nowy lub zmieniony % nie wycenia tokenów ponownie i nie odtwarza listy zdarzeń. Operuje na gotowych liczbach.

Nowe, dowolne granice historycznego pomiaru mogą wymagać przygotowania dokładnych sum w tle. Wykorzystujemy istniejące podsumowania i ograniczone fragmenty brzegowe. Nie skanujemy z tego powodu całej historii. Korekta granicy może również zmienić właściwy cykl lub zakres zależności.

Nie trzeba zaobserwować początku cyklu ani odczytu 0%. Dwa zgodne odczyty, np. 22% i 25%, pozwalają policzyć wynik przedziału, jeśli dotyczą tego samego licznika i można potwierdzić brak resetu między nimi. Brak odczytu początkowego, niepewność resetu, zerowy przyrost, sprzeczne odczyty lub osiągnięcie 100% nie uzasadniają wymyślania danych. Przy 100% późniejsze zużycie może już nie mieć odpowiadającego mu wzrostu licznika. Nie przypisujemy go bez dowodu do mierzonego przyrostu.

Zakres sumy ruchu odpowiada zakresowi licznika. Filtr projektu lub modelu nie zmienia procentu całego konta w procent tego projektu lub modelu. Częściowy ruch można pokazać jako udział w obserwowanym przyroście, z jawnym znaczeniem wyniku; nie przedstawiamy go jako pełnej pojemności abonamentu.

## 7. Precyzja jest wspólna dla wszystkich funkcji

- Tokeny źródłowe zachowują rozłączne kategorie. Nie dodajemy drugi raz cache ani reasoning zawartych już w innej kategorii.
- Tożsamość konta i źródła wynika z dowodu oraz obowiązującego w danym czasie przypisania. Aktualny login nie dowodzi właściciela dawnych sesji.
- Duplikaty, konflikty, datowane ceny, tryby i warunki naliczania rozstrzygamy wspólnie. Nieliniową wycenę, np. zależną od rozmiaru pojedynczego żądania, wykonujemy przed utratą potrzebnego kontekstu w agregacji.
- Agregaty zachowują wystarczające wymiary i miary jakości. Liczb unikalnych, średnich czy percentyli nie sumujemy jak zwykłych liczników; potrzebują poprawnej reprezentacji lub ograniczonego odczytu szczegółów.
- Tokeny sumujemy jako liczby całkowite w sprawdzonym zakresie. Kwoty mają wspólne reguły precyzji; nie zaokrąglamy każdego kroku według ustawień ekranu.
- Granice przedziałów, strefa czasowa i moment resetu mają jednoznaczny kontrakt oraz testy. Czas importu, rozmowy i konkretnego wywołania nie są zamienne.
- Wycena historyczna i porównanie przy jednym cenniku są osobnymi wariantami. Podgląd alternatywnego cennika nie nadpisuje faktów ani podstawowej wyceny.

Każdy wynik musi dać się powiązać ze źródłami, regułami i przyczynami wykluczeń. Wynik przyrostowy ma być zgodny z niezależnym pełnym przeliczeniem tego samego, zamrożonego zestawu danych.

## 8. Brak i przybliżenie pozostają widoczne

Brak ceny nie oznacza kosztu zero. Brak odczytu procentowego nie usuwa zapisanych tokenów i wycenionej części ruchu. Nieznany tryb nie staje się po cichu Standard ani Fast. Ustalenia z 6 października 2026: zapis Claude bez znacznika Fast jest trybem Standard, trybem znanym (reguła `CLAUDE_SPEED_RULE`; tak zapisują wywołania transkrypty subagentów Claude Code). Gdy zapis dostawcy rzeczywiście nie rozstrzyga trybu (Codex bez zapisanego `service_tier`), ekwiwalent API liczymy według stawki Standard jako dolną granicę (`UNKNOWN_MODE_RATE_RULE`), wywołanie pozostaje oznaczone jako „nieustalony tryb naliczania” w miarach jakości, a kredyty dla takiego wywołania pozostają niewycenione.

Rozdzielamy jakość danych od aktualności przetwarzania. „Częściowe dane” opisują ograniczenia dowodów, a „trwa aktualizacja” — stan pracy programu. Szacunek 100% nie jest potwierdzonym limitem dostawcy; ekwiwalent API nie jest opłatą za abonament.

Ręczny pomiar zachowuje oznaczenie pochodzenia. Można go edytować i usunąć bez niszczenia oryginalnych odczytów. Przybliżone daty i założenia są jawne; ich użycie nie może po cichu podnieść jakości wyniku do potwierdzonego pomiaru.

## 9. Praca w tle nie zatrzymuje odczytów

Zadania aktualizacji mają trwałą tożsamość, zakres, zależności, postęp i punkt wznowienia. Praca jest dzielona na ograniczone części. Nowy odczyt % nie czeka na przetworzenie niepowiązanej wielomiesięcznej historii.

Ciężkie obliczenia, serializacja dużych zbiorów, zapisy i porządkowanie bazy nie blokują głównej obsługi aplikacji. Transakcje zapisujące są krótkie, a procesy zapisujące koordynowane. Samo przeniesienie pracy do workera nie wystarcza, jeżeli wszystkie odczyty nadal czekają za tym workerem.

Publikacja wyniku jest spójna: obejmuje wartości i rewizje źródeł, z których je policzono. Przerwanie programu nie może pozostawić połowy nowych sum z oznaczeniem „gotowe”. Wynik obliczony na starszych danych nie nadpisuje nowszego jako aktualny.

Ostatni spójny wynik może pozostać widoczny z informacją o aktualności. Nigdy nie przedstawiamy go jako świeżego, jeśli wymaga aktualizacji. Sukces synchronizacji lub odbudowy oznacza zakończenie etapów objętych tą operacją, nie samo uruchomienie zadań.

Szybkość odczytu i czas doprowadzenia danych do aktualności są osobnymi wymaganiami. Szybkie zwracanie starego wyniku nie wystarcza. Mierzymy opóźnienie od zapisu nowego zdarzenia/% do publikacji odpowiednich sum oraz postęp kolejki pod zadeklarowanym obciążeniem.

## 10. Dwa lata historii nie zwiększają kosztu każdej drobnej zmiany

Koszt aktualizacji zależy od nowych lub poprawionych danych i ich rzeczywistych zależności. Nowe wywołanie nie przechodzi po wszystkich historycznych dniach. Nowy odczyt % korzysta z sum swojego przedziału.

Odczyt długiego zakresu może sumować gotowe podsumowania, np. około 730 dni dla dwóch lat. Koszt zależy wtedy od liczby potrzebnych podsumowań i rozbicia, nie od liczby wszystkich źródłowych wywołań.

Indeksy, wielkość odpowiedzi i retencja wynikają z rzeczywistych odczytów. Nie zapisujemy nieograniczonej liczby kopii tych samych zdarzeń pod każdym filtrem ekranu. Czyszczenie cache nie może wpędzać aplikacji w cykl: usuń potrzebne podsumowania → odtwórz historię → usuń ponownie.

## 11. Silnik bazy nie zastępuje poprawnego procesu

Podstawą obecnej aplikacji desktopowej jest lokalna baza SQLite. Wspólny rejestr musi działać niezależnie od pomocniczego cache procesu.

Zmianę silnika uzasadniamy pomiarami rzeczywistego ograniczenia, np. wymaganej współbieżności zapisów lub architektury serwerowej. Najpierw usuwamy zbędne obliczenia, zbyt szerokie unieważnianie i blokowanie odczytów. Migracja do PostgreSQL nie jest domyślnym lekarstwem na wielokrotne liczenie tych samych danych.

## 12. Nowa funkcja ma dowód zgodności

Dla zmiany dotyczącej danych lub obliczeń autor określa w opisie zadania albo PR:

1. Z jakich wspólnych faktów, wycen i sum korzysta funkcja?
2. Jakie nowe dane trzeba utrwalić i kto aktualizuje je w tle?
3. Co dokładnie unieważnia wynik, a jakie zmiany go nie dotyczą?
4. Co dzieje się po restarcie, ponowieniu, korekcie starego wpisu i przerwaniu pracy?
5. Jak zachowuje się zwykły odczyt przy pustym cache i podczas synchronizacji?
6. Jak wynik zachowuje braki, dokładność oraz możliwość sprawdzenia źródeł?
7. Jakie pomiary i testy potwierdzają powyższe?

Zakres weryfikacji odpowiada zmianie. Zmiana opisów lub dokumentacji nie wymaga uruchamiania całej historii. Zmiana silnika danych wymaga testów jego rzeczywistych ryzyk, a nie tylko zgodności z własną implementacją.

### Wymagane scenariusze dla zmienianej ścieżki danych

| Scenariusz | Oczekiwany dowód |
|---|---|
| Ponowne otwarcie i restart bez zmian | Brak ponownego parsowania i wyceny historii; gotowe wyniki przeżywają restart |
| Wyczyszczenie pomocniczego cache | Odczyt korzysta z trwałych sum, bez odbudowy faktów |
| Nowy % przy przygotowanym ruchu | Zero ponownych wycen zdarzeń, prawidłowy wynik prostych proporcji |
| Nowe zdarzenie i identyczne ponowienie | Zmieniają się tylko właściwe wyniki; ponowienie nie zmienia sum |
| Spóźniony lub poprawiony wpis | Aktualizacja właściwych historycznych zależności, zgodność z pełną referencją |
| Zmiana ceny lub przypisania | Aktualizacja dotkniętego zakresu, ponowne użycie wyników niezależnych |
| Przerwanie i wznowienie aktualizacji | Zachowanie ukończonej pracy, brak duplikatów i częściowej publikacji |
| Dwa lata danych i aktywne zadania w tle | Szybki odczyt standardowych widoków bez skanowania całej historii |

Mierzymy oddzielnie czas oczekiwania, odczytu, obliczeń, zapisu i gotowości ekranu. Liczymy faktycznie odczytane/wycenione zdarzenia oraz zaktualizowane dni i cykle. Sam komunikat „cache hit”, zapis pliku lub zielony test jednostkowy nie dowodzi przyrostowości całego procesu.

Docelowy standardowy, wcześniej przygotowany ekran powinien być gotowy w ciągu 1 s na uzgodnionej maszynie i reprezentatywnej bazie. To cel odbioru, nie twierdzenie o dzisiejszych osiągach. Wyniki podajemy z wielkością danych, stanem cache, pracą w tle, liczbą próbek oraz czasami typowymi i wolniejszych odpowiedzi. Osobno sprawdzamy nowy proces i powtórny odczyt.

## 13. Zachowujemy produkt i kontrolujemy zakres zmian

Aplikacja jest desktopowa. Prace nad danymi i wydajnością zachowują zaakceptowany układ, nawigację, filtry, sekcje i wykresy. Zmiany wyglądu wymagają odrębnej, jawnej zgody użytkownika zgodnie z [AGENTS.md](../AGENTS.md).

W zmienianym obszarze naprawiamy przyczynę i podłączamy rzeczywistych odbiorców do wspólnego rejestru. Usuwamy zastąpioną ścieżkę po sprawdzeniu zgodności; nie pozostawiamy dwóch niezależnych silników liczących to samo. Nie rozszerzamy automatycznie małego zadania na przebudowę całej aplikacji. Ujawniony dług poza zakresem zapisujemy z konkretnym wpływem i zależnościami.

Przejściowe ograniczenie musi być nazwane w opisie zmiany wraz z zakresem, skutkiem i sposobem sprawdzenia. Nie nazywamy nieukończonej migracji „w pełni przyrostową”. Starszy kod łamiący te zasady nie jest wzorcem do kopiowania w nowej funkcji.

## Dokumenty uzupełniające

- [Plan przebudowy całej aplikacji](rebuild-plan-2026-09.md) — etapy, wszystkie moduły, archiwum i pełny reset wybranych okresów.
- [Centralny system danych](central-data-system.md) — wcześniejszy opis mechanizmów i kontraktów.
- [Architektura modeli odczytu](architecture-read-models-2026-09.md) — kontekst warstw odczytu.
- [Wiarygodność pomiarów](measurement-quality-2026-09-12.md) — jakość, niepewność i sprawdzalność wyników.
- [Plan naprawy z 16 września 2026](analysis-repair-plan-2026-09-16.md) — ustalenia i wyniki konkretnego etapu prac.

Te dokumenty dostarczają kontekstu; bieżący stan wdrożenia i wyniki pomiarów nie zastępują zasad obowiązujących nowe zmiany.
