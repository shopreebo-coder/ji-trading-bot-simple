---
title: "FOREX ENGINE PRO — Controlled Integration Phase 2/3"
date: "2026-08-18"
status: "VALIDATED — PUBLISHING ACTION SUGGESTED"
---

# FOREX ENGINE PRO — Controlled Integration Phase 2/3

## 1. Cel i zakres

Celem było wpięcie istniejących Shadow A/B/C/M, Selected Engine i Knowledge Layer w kontrolowaną ścieżkę wejścia bez tworzenia nowych Shadow Engine i bez zmiany logiki ryzyka lub wykonania zleceń.

Zakres został zrealizowany jako:

```text
MARKET DATA
  → LIVE SIGNAL
  → EXISTING LIVE FILTERS
  → SHADOW A/B/C OPINIONS
  → SELECTED ENGINE
  → KNOWLEDGE EVIDENCE
  → CAPITAL GATE (ALLOW / ABSTAIN / BLOCK)
  → LIVE FINAL DECISION
  → EXISTING placeTrade()
```

Live Bot nadal posiada broker ownership, parametry zlecenia i finalną odpowiedzialność wykonawczą. Shadow, Selected Engine i Knowledge Layer nie wykonują broker calls.

## 2. Utrzymane niezmienniki

- Nie zmieniono `placeTrade()` ani argumentów `units`, `stopLossPips`, `takeProfitPips`.
- Nie zmieniono lot size, sizingu, SL/TP, trailing, break-even ani podstawowego risk management.
- Selected Engine pozostaje warstwą read-only: nie zapisuje tabel i nie wykonuje zleceń.
- Shadow Gate jest advisory-only; jego własny wynik nie jest końcowym veto.
- Controlled Capital Gate jest jedyną warstwą, która może zwrócić wykonawcze `ALLOW` albo `BLOCK`.
- `ABSTAIN`, brak danych, timeout, malformed data, NaN, konflikt lub mismatch `signalId` nigdy nie są mapowane na `ALLOW`.
- Nie użyto latest-per-engine dla bieżącego kontrolowanego sygnału.
- Nie wprowadzono weighting między Shadow A/B/C.
- Knowledge korzysta z istniejących zrealizowanych outcome’ów i artefaktów; nie wykonuje backtestingu.

## 3. Implementowane zmiany

### `index.js`

- `cooperativeEntry()` propaguje pełny kontekst decyzji, Shadow consensus, confidence, Knowledge evidence i Capital Gate reason.
- Błąd lub timeout współpracy zwraca `ABSTAIN`, nie `FAILSAFE_ALLOW`.
- Wynik Shadow Gate jest rejestrowany jako advisory i nie kończy ścieżki samodzielnie.
- Przed `placeTrade()` wymagane jest jawne `capitalGateDecision === "ALLOW"`.
- Po zablokowaniu, abstencji lub wykonaniu zlecenia zapisywany jest `controlled_live_decision` z `live_final_decision`.

### `telemetry/server.js`

- `/api/cooperative/entry` ogranicza kontrolowany consensus do dokładnie Shadow A/B/C.
- Advisory musi zawierać ten sam `signalId`, który znajduje się w bieżącym live request.
- Endpoint zwraca osobno decyzję Selected Engine i trzy-stanowy wynik Capital Gate.
- Event `cooperative_entry_decision` zawiera wymagane pola telemetryczne.

### `telemetry/managers/SelectedEngineManager.js`

- Bieżące inline opinions A/B/C są agregowane w ramach tego samego `signalId`.
- Niepełne, malformed lub rozszerzone o nieznany engine inline evidence zwraca `ABSTAIN`.
- Persisted, auto-discovered research engines pozostają w DecisionContext, rankingu i explainability, ale nie wpływają na controlled capital decision.
- Knowledge Layer odczytuje payloady aktywnych artefaktów i buduje evidence z:
  - `patterns/validated`,
  - `market/fingerprints`,
  - `expectancy/history`.
- Evidence jest read-only i opiera się na zrealizowanych rezultatach.

### `telemetry/managers/CooperativeManager.js`

- `entryPolicy()` jest advisory-only i nie posiada wykonawczego veto.
- Dodano deterministyczny Capital Gate z dokładnie trzema wynikami:
  - `ALLOW`,
  - `ABSTAIN`,
  - `BLOCK`.
- `ALLOW` wymaga kompletnego A/B/C, poprawnego signal identity, braku konfliktu, wysokiego confidence oraz dostępnego Knowledge evidence.
- `BLOCK` jest zarezerwowany dla kompletnego, wysokiego confidence `NO_TRADE`.

### `telemetry/shadowlab.js` i `telemetry/managers/SelectedAdvisor.js`

- Advisory Shadow otrzymuje jawne `signalId`.
- Consensus exposes `engineIds`, votes i recommendations, co pozwala Capital Gate zweryfikować kompletność źródła.

## 4. Kontrakt Capital Gate

| Warunek | Wynik |
|---|---|
| A/B/C kompletne, ten sam signalId, jednomyślne `TRADE`, HIGH confidence, Knowledge evidence dostępne | `ALLOW` |
| A/B/C kompletne, ten sam signalId, jednomyślne `NO_TRADE`, HIGH confidence, Knowledge evidence dostępne | `BLOCK` |
| Konflikt A/B/C | `ABSTAIN` |
| Brak któregoś z A/B/C | `ABSTAIN` |
| Nieznany engine lub malformed recommendation | `ABSTAIN` |
| Brak Knowledge evidence | `ABSTAIN` |
| LOW/MEDIUM confidence | `ABSTAIN` |
| Timeout/awaria Selected, Shadow lub Knowledge | `ABSTAIN` |
| NaN lub niepełne live evidence | `ABSTAIN` |
| Niezgodny `signalId` | `ABSTAIN` |

Nie istnieje implicit fail-open w tej kontrolowanej ścieżce.

## 5. Telemetria

Eventy `cooperative_entry_decision` i `controlled_live_decision` zawierają:

- `shadow_consensus`
- `shadow_confidence`
- `selected_engine_decision`
- `selected_engine_confidence`
- `knowledge_evidence`
- `capital_gate_decision`
- `capital_gate_reason`
- `live_final_decision`

`live_final_decision` jest rozstrzygane dopiero przez Live Bot:

- `TRADE` — istniejąca egzekucja zakończyła się powodzeniem,
- `NO_TRADE` — Capital Gate zwrócił `BLOCK` albo wykonanie zlecenia nie nastąpiło,
- `ABSTAIN` — gate nie miał wystarczających danych lub wystąpiła awaria.

## 6. Testy

### Testy kontrolowanej integracji

Dodano i uruchomiono testy dla:

- normalnego sygnału z pełnym A/B/C i Knowledge evidence,
- jednomyślnego consensus,
- konfliktu A/B/C,
- LOW confidence,
- braku Knowledge evidence,
- `ALLOW`,
- `ABSTAIN`,
- `BLOCK`,
- awarii/malformed Shadow,
- awarii/malformed Selected,
- awarii/braku Knowledge,
- brakującego A/B/C,
- nieznanego dodatkowego engine,
- mismatch `signalId`.

Testy kontraktowe kontrolowanej ścieżki: **38/38 PASS**.

### Pełna walidacja telemetryczna

Uruchomiono sekwencyjnie wszystkie pliki:

```text
telemetry/tests/unit/*.test.js
telemetry/tests/integration/*.test.js
telemetry/tests/simulation/*.test.js
telemetry/tests/stress/*.test.js
```

Wynik: **wszystkie pliki testowe zakończyły się sukcesem**.

Test Memory Integration wymagał zatrzymania workflow Telemetry Dashboard, ponieważ działający proces trzymał globalny PostgreSQL advisory lock. Po zwolnieniu locka test przeszedł 18/18. Workflow został następnie uruchomiony ponownie.

### Kontrola runtime

Po restarcie:

- `Telemetry Dashboard` — RUNNING,
- `artifacts/api-server: API Server` — RUNNING,
- `artifacts/mockup-sandbox: Component Preview Server` — RUNNING.

Logi nie wykazały błędów startowych związanych z integracją. OANDA zwraca `401 Insufficient authorization`, ponieważ w bieżącym runtime nie ma aktywnego account/API authorization; strategia poprawnie nie wykonuje wtedy trade.

## 7. Problemy i ograniczenia

- Publikowanie nie jest wykonywane automatycznie przez agenta. Po przejściu testów została zasugerowana akcja Publish; użytkownik musi ją zatwierdzić w Replit.
- Bieżący brak autoryzacji OANDA jest problemem środowiska brokera, a nie regresją controlled integration.
- Przy braku Knowledge evidence Capital Gate będzie konserwatywnie zwracał `ABSTAIN`, zgodnie z wymaganiem fail-closed.

## 8. Status końcowy

**Kod:** zaimplementowany i zweryfikowany.  
**Testy:** zaliczone.  
**Workflow:** uruchomiony i sprawdzony.  
**Deploy/publish:** gotowy do zatwierdzenia przez użytkownika; nie wykonano samowolnego publish.  
**Broker ownership:** pozostaje w Live Bot.  
**Nowe Shadow Engine:** nie utworzono.