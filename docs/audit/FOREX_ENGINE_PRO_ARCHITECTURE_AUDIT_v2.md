# FOREX ENGINE PRO — AUDYT ARCHITEKTURY WSPÓŁPRACY LIVE / SHADOW / SELECTED

**Wersja 2.0 — raport aktualizacyjny po audycie kodu źródłowego**  
**Data audytu:** 2026-08-18  
**Zakres:** `index.js`, `telemetry/server.js`, `telemetry/shadowlab.js`, `telemetry/shadowm.js`, `telemetry/managers/**`, migracje telemetryczne oraz bieżąca konfiguracja workflow telemetrycznego.  
**Zasada dowodowa:** kod wykonawczy jest źródłem prawdy; dokumentacja i wcześniejsze raporty mają niższy priorytet.

---

## 1. WERDYKT WYKONAWCZY

FOREX ENGINE PRO nie jest obecnie w pełni zamkniętym łańcuchem:

`Shadow A/B/C → Selected Advisor → Live decision context`

Jest to układ częściowo podłączony, w którym istnieją dwa różne strumienie oceny:

1. **Live Shadow Gate** — uruchamiany synchronicznie dla bieżącego kandydata wejścia i zapisujący `shadow_gate_eval`, `shadow_advisory` oraz zdarzenia per-engine.
2. **Shadow LAB research** — uruchamiany przez reconciler na zdarzeniach `trade_open`, a następnie zapisujący `lab_shadow_a/b/c/d` oraz rekordy w `shadow_engine_evals`.

Te strumienie nie są obecnie tym samym kontraktem danych. Selected Engine czyta przede wszystkim utrwalone rekordy researchowe, a nie bezpośrednio wyniki A/B/C przekazane przez `shadowGate()`. W konsekwencji:

- A/B/C mogą wygenerować i dostarczyć bieżące advisory, ale Selected Engine może nie mieć dla tego samego `signalId` żadnych zapisanych ocen.
- brak ocen tego samego sygnału jest prawidłowo traktowany jako brak dowodu / `ABSTAIN`, a nie uzupełniany najnowszym rekordem innego sygnału;
- `entryPolicy()` ma jednak realną zdolność zwrócenia `BLOCK` dla wysokiej pewności `NO_TRADE`, więc `usedForDecision: false` nie opisuje całego rzeczywistego zachowania;
- Shadow M nie wykonuje brokera bezpośrednio, ale jego `MOVE_BE` i `MOVE_SL` są używane przez Live Exit przy modyfikacji stop-lossa.

**Ogólna klasyfikacja:** rdzeń Live i broker są podłączone; Shadow Gate jest podłączony; bezpośrednie advisory A/B/C → Selected Advisor jest podłączone; producent ocen researchowych i konsument Selected Engine są rozdzielone zakresem cyklu życia; Selected Engine i Shadow M mają rzeczywisty wpływ na ścieżki Live zależnie od konfiguracji i wyniku.

---

## 2. KONFIGURACJA I GRANICE AUDYTU

### 2.1 Bieżący workflow telemetryczny

W snapshotcie środowiska workflow telemetryczny uruchamia:

```text
PORT=8083
SHADOW_LAB_RESEARCH=on
KNOWLEDGE_LAYER=on
SELECTED_ENGINE=on
SELECTED_ADVISOR=on
TELEMETRY_RECONCILER=on
node telemetry/server.js
```

To opisuje konfigurację workflowu w workspace. Nie jest dowodem, że każda instancja produkcyjna używa identycznych wartości ani że tryb Shadow Gate jest `OBSERVE`; tryb jest także odtwarzany z ostatniego zdarzenia `shadow_mode_change`.

### 2.2 Nienaruszone granice

W ramach tego audytu:

- nie zmieniono `index.js`;
- nie zmieniono parametrów Live Entry, Risk, Exit, SL/TP, sizingu ani lot size;
- nie zmieniono workflowów ani sekretów;
- nie wykonano deployu;
- nie wykonano broker call ani testu na realnym rachunku;
- wynik `usedForDecision` nie został interpretowany jako wystarczający dowód bezpieczeństwa — prześledzono faktyczne warunki sterujące.

---

## 3. TOPOLOGIA RUNTIME

```text
telemetry/server.js
  ├─ HTTP API + dashboard + manager tier
  ├─ ShadowLab.start()                  [A/B/C/D research helper]
  ├─ ShadowM.start()                    [exit research]
  ├─ ShadowLabManager.start()           [flag gated reconciler]
  ├─ KnowledgeManager                   [flag gated]
  ├─ SelectedAdvisor                    [flag gated]
  ├─ SelectedEngineManager              [flag gated background poll]
  └─ spawns index.js

index.js
  ├─ market data / OANDA pricing
  ├─ M5 + M1 strategy and Live filters
  ├─ shadowGate(signal)
  ├─ cooperativeSignal(signal, shadowAdvisory)   [fire-and-forget]
  ├─ cooperativeEntry(signal, shadowAdvisory)    [awaited]
  ├─ placeTrade(...)                              [broker owner]
  └─ manageTrades() → cooperativeAdvisory(...) → Live Exit

Shared event spine: events
Research tables: shadow_signals, shadow_engine_evals, shadow_outcomes,
                 shadow_expectancy_snapshots
Knowledge tables: knowledge_artifacts, knowledge_snapshots
```

`server.js` jest właścicielem orkiestracji telemetrycznej, ale `index.js` pozostaje właścicielem wykonania zleceń OANDA. Warstwa managerów nie wykonuje broker calls.

---

## 4. PRAWDZIWY PRZEPŁYW DANYCH

### 4.1 Wejście

```text
OANDA market data
  → index.js strategy()
  → M5 analysis
  → M1 analysis
  → condition maps / entry metadata
  → shadowGate()
  → Live quality filters
  → cooperative entry handshake
  → placeTrade()
```

Po poprawce kolejności `shadowGate()` znajduje się przed filtrami exhaustion, spread-edge, pullback i margin. Dzięki temu Shadow Gate może obserwować także sygnały, które później nie przejdą do brokera.

### 4.2 Live Shadow Gate

`shadowGate()` synchronicznie uruchamia A, B, C i D. Zapisuje między innymi:

- `shadow_gate_eval`;
- `shadow_advisory`;
- `shadow_a_advisory_generated`;
- `shadow_b_advisory_generated`;
- `shadow_c_advisory_generated`;
- zdarzenia blokady, gdy obowiązują warunki trybu GATE.

W trybie `OBSERVE` Shadow Gate zwraca `blocked: false`. W trybie `GATE` blokada jest dopuszczona dla wysokiej pewności negatywnej rekomendacji Meta D. Błąd Shadow Gate jest fail-safe i nie powinien zatrzymać Live.

### 4.3 Direct cooperative path

`index.js` przekazuje advisory do:

```text
/api/cooperative/signal   — powiadomienie fire-and-forget
/api/cooperative/entry    — oczekiwany handshake przed brokerem
```

Selected Advisor:

- waliduje obecność A/B/C;
- zapisuje lifecycle events;
- buduje stan wejścia w pamięci;
- może utworzyć `delivered`, `read` i `selected_advisor_advisory_generated`.

Ten transport jest realnie podłączony. Nie oznacza jednak, że wynik przekazany w `advisoryOutputs` został użyty przez Selected Engine do obliczenia wyniku.

### 4.4 Research path

ShadowLabManager ma kontrakt:

```text
trade_open
  → shadow_signals
lab_shadow_a/b/c/d
  → shadow_engine_evals
trade_close
  → shadow_outcomes
```

Natomiast aktywny `ShadowLab` w `telemetry/shadowlab.js` przetwarza w `_cycle()` przede wszystkim historyczne `trade_open` i dopiero wtedy generuje `lab_shadow_a/b/c/d`.

Najważniejsza różnica:

```text
shadow_gate_*_advisory_generated
shadow_advisory
        ≠
lab_shadow_a/b/c/d
        ≠
shadow_engine_evals
```

Nie znaleziono aktywnego bieżącego emitera, który dla każdego sygnału z `shadowGate()` tworzyłby `lab_shadow_a/b/c/d` przed wejściem do Selected Engine. Emitery o takich nazwach występują w aktywnym reconcilerze dla cyklu `trade_open` oraz w kodzie archiwalnym/dokumentacji, lecz nie zamykają bieżącego handoffu kandydata Live.

### 4.5 Knowledge i Selected

```text
shadow_* research tables
  → KnowledgeManager
  → knowledge_artifacts / knowledge_snapshots
  → SelectedEngineManager
  → DecisionContext / EvidenceTrace / consensus
```

To połączenie jest rzeczywiste i read-only po stronie Selected Engine. Knowledge Layer nie jest bezpośrednio zapisywany przez Selected Engine i nie wykonuje brokera.

---

## 5. KLASYFIKACJA POŁĄCZEŃ

| Połączenie | Status | Dowód z kodu | Konsekwencja |
|---|---|---|---|
| Market data → Live strategy | CONNECTED | `strategy()` pobiera M5/M1 i buduje sygnał | Live ma wejściowe dane rynkowe |
| Live → Shadow Gate | CONNECTED | `shadowGate()` wywoływany przed filtrami i entry path | A/B/C/D mogą obserwować także odrzucenia Live |
| Shadow Gate → event spine | CONNECTED | `logEvent()` dla gate/advisory events | Bieżące advisory są utrwalane w `events` |
| Shadow Gate A/B/C → `lab_shadow_*` | NOT CONNECTED dla bieżącego kandydata | brak aktywnego emitera tego handoffu przed `trade_open` | Selected research może nie widzieć bieżącego sygnału |
| `trade_open` → ShadowLab research | CONNECTED, ale zakres ograniczony | reconciler przetwarza otwarte transakcje | Research dobrze opisuje transakcje, nie wszystkie kandydatury |
| Direct advisory → Selected Advisor | CONNECTED | `/api/cooperative/signal` / `/entry`, walidacja A/B/C i lifecycle | Advisor otrzymuje bieżący kontekst |
| `advisoryOutputs` → Selected Engine | PARTIALLY CONNECTED | outputy są przekazane do endpointu, lecz `evaluateEntry()` buduje kontekst z DB | Przekazany wynik A/B/C nie jest bezpośrednim wejściem do konsensusu |
| `shadow_engine_evals` → Selected Engine | CONNECTED | `_getEvals(signalId)` i dynamiczne plugin adapters | Zapisane oceny tego samego sygnału są używane |
| Research → Knowledge Layer | CONNECTED, gdy flaga aktywna | KnowledgeManager czyta research i zapisuje artefakty | Wiedza jest versioned/read-only dla konsumenta |
| Knowledge Layer → Selected Engine | CONNECTED | aktywne knowledge artifacts i snapshot manifest trafiają do rankingu | Wiedza uczestniczy w `DecisionContext` i EvidenceTrace |
| Selected Engine → Live entry | PARTIALLY CONNECTED / LIVE-INFLUENCING | `entryPolicy()` może zwrócić `BLOCK`; `index.js` kończy entry path | `usedForDecision:false` nie opisuje rzeczywistej zdolności blokowania |
| Shadow M → Live Exit | CONNECTED jako advisory influence | `decideManagement()` wybiera akcję, a Live używa `MOVE_BE` / `MOVE_SL` | Shadow M może zmienić moment modyfikacji SL |
| Live → broker | CONNECTED | `placeTrade()`, `closeTrade()`, OANDA REST | Live pozostaje właścicielem broker calls |
| Exit Engine X → Live Exit | OBSERVATION ONLY | `evaluate()` i `onTradeClose()` są fire-and-forget | Nie wpływa na decyzję Live |

---

## 6. ANALIZA SCENARIUSZY

### 6.1 Sygnał odrzucony przez filtr Live po Shadow Gate

Przepływ:

```text
signal_detected
  → M5/M1
  → condition maps
  → shadowGate()
  → A/B/C/D advisory events
  → spread/exhaustion/pullback/margin block
  → no trade_open
```

**Wynik:** Shadow Gate obserwuje sygnał. Selected Advisor może otrzymać direct advisory przez `/api/cooperative/signal`. ShadowLabManager nie ma jednak `trade_open`, na którym opiera swój aktualny pipeline researchowy, więc `shadow_engine_evals` dla tego `signalId` nie muszą powstać.

### 6.2 Sygnał przechodzący do entry path

Przepływ:

```text
shadowGate()
  → Live filters pass
  → cooperativeEntry()
  → selectedEngine.evaluateEntry()
  → cooperativeManager.entryPolicy()
  → placeTrade() albo fail-open
```

**Wynik:** Selected Engine jest konsultowany przed brokerem. Jednak bieżące A/B/C `advisoryOutputs` nie są używane jako bezpośrednie rekordy engine opinions. Dla nowego `signalId` Shadow LAB może jeszcze nie mieć persisted evaluations, więc Selected Engine powinien zwrócić brak dowodu / `ABSTAIN`, a bounded refresh może jedynie ponownie odczytać ten sam `signalId`.

Jeśli w przyszłości dla tego samego `signalId` pojawi się komplet ocen i wynik będzie wysokiej pewności `NO_TRADE`, `entryPolicy()` może zwrócić `BLOCK`. To jest realny wpływ na Live Entry, niezależnie od pola telemetrycznego `usedForDecision`.

### 6.3 Transakcja otwarta

Po broker acknowledgement i wykryciu otwartej pozycji generowany jest `trade_open`. Dopiero wtedy aktywne pipeline’y researchowe mogą zapisać:

```text
shadow_signals
shadow_engine_evals
```

To zapewnia późniejszy materiał dla Knowledge Layer i Selected Engine, ale nie naprawia braku dowodu w synchronicznym momencie decyzji wejścia.

### 6.4 Zarządzanie otwartą pozycją

`manageTrades()`:

1. odczytuje stan pozycji z OANDA;
2. wylicza `_liveExitNatural`;
3. pyta `cooperativeAdvisory()` o Shadow M;
4. wyznacza `cooperativeAction`;
5. używa wyniku przy warunkach break-even i MFE floor;
6. wykonuje modyfikacje SL przez OANDA.

Live pozostaje właścicielem brokera i warunków zamknięcia, ale Shadow M nie jest już czystą obserwacją. `MOVE_BE` może przyspieszyć break-even, a `MOVE_SL` może uaktywnić floor protection. `REQUEST_CLOSE` Shadow M nie jest samodzielnym broker close w pokazanej ścieżce.

---

## 7. SELECTED ENGINE — RZECZYWISTE ZACHOWANIE

### 7.1 Co jest poprawne

- kontekst jest budowany read-only;
- oceny są filtrowane po tym samym `signalId`;
- brak oceny nie jest zastępowany najnowszym rekordem innego sygnału;
- konsensus jest tri-state;
- silniki abstainujące są wyłączone z licznika głosów;
- Knowledge artifacts są dynamicznymi rekordami rankingu;
- ranking nie jest zwykłym winrate;
- błędy i brak danych mają ścieżkę `ABSTAIN` / fail-open.

### 7.2 Co jest niepełne

`evaluateEntry()` dostaje `advisoryOutputs`, ale `SelectedEngineManager.evaluateEntry()` nie traktuje ich jako bezpośrednich opinii A/B/C. Buduje `DecisionContext` na podstawie:

```text
signal + shadow_engine_evals(signalId) + outcomes + discovered engines + knowledge
```

Dlatego direct A/B/C handoff do Selected Advisor jest podłączony, lecz direct A/B/C handoff do Selected Engine nie jest kompletny.

### 7.3 Wpływ na Live

`CooperativeManager.entryPolicy()` mapuje:

```text
NO_TRADE + HIGH confidence → BLOCK
TRADE + HIGH confidence     → ALLOW
pozostałe                   → ADVISORY
```

`index.js` kończy ścieżkę wejścia dla `BLOCK`. Nie jest to wyłącznie telemetryczne oznaczenie. W aktualnym kodzie Selected Engine ma więc zdolność wpływu na Live Entry, choć typowo pozostanie fail-open, dopóki nie ma kompletnego dowodu dla tego samego sygnału.

**Wniosek polityczny:** jeżeli wymaganiem nadrzędnym nadal jest „Selected Advisor nigdy nie może zmienić decyzji Live”, obecna implementacja nie spełnia tego wymagania. Jeżeli dopuszczona jest kontrolowana blokada wysokiej pewności, należy ją opisać jako aktywną politykę, a nie jako `usedForDecision:false`.

---

## 8. KNOWLEDGE LAYER

### Status: CONNECTED, READ-ONLY, ZALEŻNY OD RESEARCH INPUT

KnowledgeManager:

- czyta dane researchowe;
- buduje domeny knowledge artifacts;
- zapisuje versioned immutable artifacts i snapshots;
- utrzymuje provenance i content-only checksum;
- nie steruje bezpośrednio Live Botem.

Selected Engine:

- ładuje aktywne artefakty;
- ładuje manifest snapshotu;
- dodaje artefakty do rankingu i EvidenceTrace;
- nie zapisuje Knowledge Layer.

Ograniczenie jest upstreamowe: jeśli bieżący sygnał nie trafia do `shadow_engine_evals`, Knowledge Layer nie może wytworzyć wiarygodnego artefaktu dla tego brakującego sygnału. Warstwa jest poprawnie podłączona do researchu, ale nie kompensuje braku producenta.

---

## 9. RISK, CAPITAL I FAIL-SAFE

Z audytowanego `index.js` wynikają następujące istniejące ograniczenia:

- `RISK_PERCENT` domyślnie `0.01`;
- `MAX_OPEN_TRADES` domyślnie `2`;
- `MAX_DAILY_TRADES` domyślnie `50`;
- cooldown po transakcji;
- jedna pozycja na symbol;
- correlation block;
- `DISABLED_SYMBOLS`;
- spread block powyżej `2.0`;
- exhaustion, spread-edge, pullback i margin blocks;
- defensive mode po trzech stratach;
- ATR-based SL/TP;
- break-even, trailing stop, MFE floor, early/momentum/time exit.

Mechanizmy `ABSTAIN` są obecne w kilku miejscach:

- Shadow C zwraca `null` przy braku wystarczającej historii;
- Shadow Gate mapuje brak decyzji do `ABSTAIN`;
- Selected consensus wyklucza abstaining engines;
- brak danych daje `NO_DATA` i kończy się `ABSTAIN`;
- błąd Selected Engine jest fail-open.

**Ważne:** fail-open ogranicza ryzyko zatrzymania Live, ale nie zmienia faktu, że w pełnym dowodzie Selected Engine może zwrócić `BLOCK`. To jest polityka decyzyjna, nie tylko mechanizm obserwacyjny.

---

## 10. OCENA GOTOWOŚCI

| Obszar | Ocena | Uzasadnienie |
|---|---:|---|
| Live broker ownership | 100% | Broker calls są w `index.js` |
| Market data → Live strategy | 100% | M5/M1 i filtry są aktywne |
| Shadow Gate observation | 90% | A/B/C/D są uruchamiane przed filtrami i logowane |
| Shadow Gate → research tables | 35% | brak wspólnego bieżącego handoffu do `lab_shadow_*` |
| Direct Shadow → Selected Advisor | 80% | transport, walidacja i lifecycle istnieją |
| Direct outputs → Selected Engine | 45% | outputy są przekazane, ale nie są źródłem opinii |
| Research → Knowledge | 90% | pipeline jest connected przy aktywnej fladze |
| Knowledge → Selected | 90% | read-only aggregation działa |
| Selected → Live policy | 70% | realny gate istnieje, ale granica `usedForDecision` jest niejednoznaczna |
| Shadow M → Live Exit | 70% | advisory realnie zmienia warunki SL/BE |
| Observability / status | 80% | status pokazuje część wpływu; potrzebuje rozróżnienia direct vs persisted |

**Ocena ogólna dla celu „pełna współpraca”: PARTIALLY CONNECTED.**  
**Ocena dla bezpiecznego działania Live core:** działający rdzeń, ale z aktywnymi, konfiguracyjnie zależnymi ścieżkami wpływu advisory.

---

## 11. NAJWAŻNIEJSZE LUKI

### P0 — rozdzielenie bieżącego advisory od research evidence

Ten sam `signalId` może mieć:

```text
shadow_advisory / shadow_*_advisory_generated
```

bez:

```text
shadow_engine_evals
```

To jest główna luka funkcjonalna w deklarowanym łańcuchu współpracy.

### P0 — niespójna deklaracja wpływu Selected Engine

`usedForDecision:false` jest sprzeczne z faktem, że `entryPolicy()` może zwrócić `BLOCK`, a `index.js` może zakończyć ścieżkę przed `placeTrade()`. Należy wybrać i udokumentować jedną politykę:

- Selected jest advisory-only i nigdy nie blokuje; albo
- Selected ma kontrolowaną blokadę high-confidence i telemetryka to jawnie pokazuje.

### P1 — Shadow M nie jest observation-only

Shadow M może wpływać na break-even i MFE floor. To wymaga osobnego review, progów, telemetryki i zgody operacyjnej, jeśli pierwotną granicą miał być czysty observer.

### P1 — status dashboardu powinien rozróżniać warstwy

Status „pipeline evaluations” może sugerować pełną obecność A/B/C, gdy część danych pochodzi z direct advisory, a część z research tables. Raportowanie powinno osobno pokazywać:

- live gate evaluations;
- direct Selected Advisor deliveries;
- same-signal persisted research evaluations;
- Selected decision context;
- actual Live influence.

---

## 12. REKOMENDOWANE NASTĘPNE KROKI — BEZ WYKONYWANIA W TYM AUDYCIE

1. **Zdefiniować jeden lifecycle contract dla `signal_detected`.** Producer research powinien obserwować ten sam zakres sygnałów co consumer Selected, także dla sygnałów odrzuconych przed `trade_open`.
2. **Ustalić kontrakt wejściowy Selected Engine.** Albo przyjmuje zweryfikowane A/B/C jako inline evidence, albo jawnie wymaga persisted `shadow_engine_evals`; nie należy mieszać obu semantyk.
3. **Dodać test identyfikacji po `signalId`.** Osobno dla kandydata odrzuconego przez Live i dla transakcji, która doszła do `trade_open`.
4. **Rozdzielić telemetrykę advisory-only od block-capable.** `usedForDecision`, `influencesLive` i decyzja `entryPolicy()` powinny opisywać ten sam stan faktyczny.
5. **Wykonać osobny review Shadow M.** Potwierdzić, czy `MOVE_BE` / `MOVE_SL` są zaakceptowanym wpływem Live, czy należy je ograniczyć do obserwacji.
6. **Dopiero po tych zmianach uruchomić kontrolowaną walidację danych.** Ten audyt nie rekomenduje przełączenia trybu GATE ani deployu.

---

## 13. DOWODY I OGRANICZENIA AUDYTU

Audyt oparto na:

- bieżącym `index.js`;
- bieżącym `telemetry/shadowlab.js`;
- `telemetry/shadowm.js`;
- `telemetry/server.js`;
- `telemetry/managers/ShadowLabManager.js`;
- `telemetry/managers/KnowledgeManager.js`;
- `telemetry/managers/KnowledgeRepository.js`;
- `telemetry/managers/SelectedEngineManager.js`;
- `telemetry/managers/SelectedAdvisor.js`;
- `telemetry/managers/CooperativeManager.js`;
- `telemetry/managers/ModuleStatusManager.js`;
- migracjach telemetrycznych;
- konfiguracji workflowu przedstawionej w snapshotcie.

Wykonano statyczną kontrolę składni `index.js`, zakończoną powodzeniem przed rozpoczęciem tego raportu. Nie wykonano testu z aktywnym brokerem, nie zmieniono kodu produkcyjnego i nie wykonano deployu. Brak danych runtime w tym raporcie nie jest dowodem, że połączenie działa — klasyfikacja wynika z tras, event types, zapytań i warunków sterujących obecnych w kodzie.

---

## 14. KONKLUZJA

System ma solidny, fail-safe Live core i działające elementy Shadow OS, ale pełny cel współpracy nie jest jeszcze spełniony jako jeden spójny kontrakt.

Najważniejsze zdanie audytu:

> **Shadow Gate widzi bieżący sygnał, Selected Advisor może dostać bieżące advisory, lecz Selected Engine podejmuje ocenę na podstawie persisted research evidence, którego producent obecnie nie obserwuje tego samego zakresu lifecycle co direct advisory.**

Jednocześnie:

> **Selected Engine może faktycznie zablokować wejście przy high-confidence `NO_TRADE`, a Shadow M może wpływać na modyfikacje SL. Dlatego systemu nie należy opisywać jako całkowicie observation-only ani jako całkowicie advisory-only bez doprecyzowania polityki.**

**Final status: PARTIALLY CONNECTED — LIVE CORE OPERATIONAL, COOPERATIVE CONTRACT INCOMPLETE, NO DEPLOY PERFORMED.**
