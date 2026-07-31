# Audyt zgodności wdrożenia i przepływu diagnostyki Selected Engine

**Data audytu:** 2026-07-31  
**Zakres:** commit `Add Selected Engine diagnostics` oraz pełna ścieżka diagnostyczna:

```text
lokalny commit
  → lokalny HEAD
  → origin/main
  → GitHub main
  → Railway deployment
  → uruchomiony kontener
  → endpointy telemetryczne
  → dashboard
```

**Charakter audytu:** wyłącznie odczytowy.  
**Zmiany w kodzie aplikacji:** nie wykonano.  
**Nowe commity:** nie utworzono.  
**Push:** nie wykonano.  
**Deploy:** nie wykonano.  
**Restart workflow:** nie wykonano w ramach tego audytu.

---

## 1. Executive Summary

Audyt dotyczył patcha diagnostycznego z commitem:

```text
07cb3c16007833fd99b18f980829b356f694e67c
Add Selected Engine diagnostics
```

Patch zmienia wyłącznie trzy pliki:

```text
telemetry/managers/SelectedEngineManager.js
telemetry/public/index.html
telemetry/server.js
```

Weryfikacja lokalna i w publicznym repozytorium GitHub wykazała pełną zgodność:

```text
lokalny HEAD     = 07cb3c16007833fd99b18f980829b356f694e67c
origin/main      = 07cb3c16007833fd99b18f980829b356f694e67c
GitHub main      = 07cb3c16007833fd99b18f980829b356f694e67c
```

Oznacza to, że weryfikowany commit został zapisany lokalnie, branch `origin/main`
wskazywał ten sam obiekt Git, a publiczny branch `main` na GitHub również wskazywał
ten sam SHA.

W bieżącym uruchomionym workflow telemetrycznym patch był aktywny. Dowód
proweniencji procesu:

```text
systemVersion = v40.1
buildId       = v40.1+07cb3c160078
runId         = 092e9cda-52a1-4b70-b7f3-8e0288c5a7dd
configHash    = 7425a852943c845d1c5d986622f79b41f54587e47d125b5230de20048d0bd09d
```

W tej instancji działają wszystkie kluczowe elementy backendowej ścieżki
diagnostycznej. Endpoint `/api/selected/context` zwracał:

```text
source = ring_buffer
```

oraz następujące liczniki:

```text
DecisionContext_build_started = 212
DecisionContext_build_success = 212
DecisionContext_build_failed  = 0
cooperativeSignal_sent        = 211
cooperativeSignal_success     = 211
cooperativeSignal_failed      = 0
```

Endpoint zwracał także:

```text
Dashboard_latestContext_source = ring_buffer
Dashboard_latestContext_signalId = 0f1b85b0-8459-4ef1-bc22-044708f4b887
Dashboard_latestContext_timestamp = 2026-07-31T08:41:49.933Z
```

Na podstawie tych danych nie można wskazać błędu w samym backendowym patchu
diagnostycznym. Liczniki są zapisywane, konteksty są budowane, kontekst trafia
do ring buffera, a endpointy zwracają nowe pola.

Jednocześnie nie udało się niezależnie potwierdzić produkcyjnego wdrożenia
Railway przy użyciu dostępnych metadanych i logów. Odczyt narzędzi wdrożeniowych
zwrócił:

```json
{
  "success": true,
  "isDeployed": false,
  "hasSuccessfulBuild": false,
  "primaryUrl": "",
  "deploymentType": ""
}
```

oraz:

```text
No deployment logs found.
```

Jest to sprzeczne z przekazanym potwierdzeniem użytkownika:

```text
Deployment successful via GitHub
```

Ta sprzeczność nie dowodzi, że Railway nie wdrożył commita. Oznacza wyłącznie,
że w ramach dostępnego audytu nie było niezależnego, odczytowego dowodu
z metadanych Railway, historii deploymentów, SHA deploymentu ani logu startowego
produkcji.

Najważniejszy wniosek:

> Łańcuch lokalny → `origin/main` → GitHub jest potwierdzony. Bieżący lokalny
> workflow uruchamia patch diagnostyczny. Backendowa ścieżka diagnostyczna
> działa. Pierwszym etapem bez niezależnego potwierdzenia pozostaje
> GitHub → Railway, a pierwszym niepotwierdzonym warunkiem po stronie UI jest
> skuteczne wykonanie `refreshSelected()` przez właściwy dashboard Railway
> i dojście do `setSelected()`.

---

## 2. Cel audytu

Cele audytu były następujące:

1. Zweryfikować, czy lokalny commit `Add Selected Engine diagnostics` istnieje
   i ma oczekiwany SHA.
2. Zweryfikować, czy lokalny `HEAD` wskazuje ten commit.
3. Zweryfikować, czy lokalny `origin/main` wskazuje ten sam commit.
4. Zweryfikować publiczny branch `main` na GitHub.
5. Zweryfikować, czy Railway ma aktywne i zakończone sukcesem wdrożenie.
6. Zweryfikować, czy Railway przypisał deploymentowi konkretny SHA.
7. Zweryfikować, czy uruchomiony kontener publikuje jednoznaczny identyfikator
   buildu związany z patchem.
8. Prześledzić wszystkie miejsca, w których patch:
   - zwiększa liczniki,
   - zapisuje diagnostyczne eventy,
   - emituje logi,
   - udostępnia pola endpointów,
   - aktualizuje dashboard.
9. Wskazać pierwszy etap, na którym wersje mogły się rozjechać albo którego
   nie można niezależnie potwierdzić.
10. Ustalić, czy brak zmiany w dashboardzie wynika z backendu, endpointów,
    przepływu sygnału, czy z warstwy przeglądarki/instancji produkcyjnej.

---

## 3. Metodologia

Audyt wykonano w następujących warstwach.

### 3.1. Git lokalny

Odczytano:

```text
git rev-parse HEAD
git branch --show-current
git status --short --branch
git rev-parse origin/main
git show --stat --summary <commit>
git show --name-status <commit>
git grep <diagnostic markers> <commit>
```

Nie wykonano:

```text
git commit
git push
git reset
git checkout
```

### 3.2. GitHub

Odczytano publiczne GitHub API:

```text
GET /repos/shopreebo-coder/ji-trading-bot-simple/commits/07cb3c16007833fd99b18f980829b356f694e67c
GET /repos/shopreebo-coder/ji-trading-bot-simple/git/ref/heads/main
```

Sprawdzono SHA commita, message, URL, autora, pliki oraz SHA brancha `main`.

### 3.3. Railway i dane deploymentu

Wykonano wyłącznie odczyty:

```text
getDeploymentInfo()
fetchDeploymentLogs()
```

Wykonano również wyszukiwanie po potencjalnych identyfikatorach:

```text
07cb3c1
07cb3c16007833fd99b18f980829b356f694e67c
build_id
commit
cooperativeSignal_sent
cooperativeSignal_success
DecisionContext_build_started
Dashboard_latestContext_source
```

### 3.4. Kod aplikacji

Prześledzono:

```text
index.js
telemetry/server.js
telemetry/index.js
telemetry/managers/SelectedEngineManager.js
telemetry/public/index.html
telemetry/shadowm.js
```

Przeglądano tylko miejsca związane z:

```text
signal_detected
cooperativeSignal
selected_diagnostic
DecisionContext_build_*
Dashboard_latestContext_*
/api/selected/status
/api/selected/context
refreshSelected
SelectedTab
```

### 3.5. Workflow i endpointy uruchomionej instancji

Odczytano log workflow:

```text
/tmp/logs/Telemetry_Dashboard_20260731_084132_710_a66df52b.log
```

oraz odpowiedzi:

```text
GET http://127.0.0.1:8083/api/selected/status
GET http://127.0.0.1:8083/api/selected/context
```

### 3.6. Dashboard

Sprawdzono:

```text
telemetry/public/index.html
```

ze szczególnym uwzględnieniem:

```text
TABS
refresh()
refreshSelected()
useEffect(..., [])
useEffect(..., [tab])
SelectedTab()
```

---

## 4. Wyniki krok po kroku

## 4.1. Lokalny commit

### Identyfikator

```text
SHA:     07cb3c16007833fd99b18f980829b356f694e67c
Message: Add Selected Engine diagnostics
Branch:  main
```

### Daty i autor

```text
Author:       shopreebo-coder <shopreebo@gmail.com>
Author date:  2026-07-30T22:08:00Z
Commit date:  2026-07-30T22:08:00Z
```

### Zmienione pliki

```text
telemetry/managers/SelectedEngineManager.js
telemetry/public/index.html
telemetry/server.js
```

### Statystyka commita

```text
3 files changed
235 insertions(+)
14 deletions(-)
```

### Wynik

Commit istnieje lokalnie i zawiera oczekiwany patch diagnostyczny.

---

## 4.2. Lokalny `HEAD`

### Dowód

```text
git rev-parse HEAD
07cb3c16007833fd99b18f980829b356f694e67c
```

```text
git log -1
commit=07cb3c16007833fd99b18f980829b356f694e67c
subject=Add Selected Engine diagnostics
```

### Status

```text
## main...origin/main
```

Nie wykazano lokalnych niezacommitowanych zmian:

```text
git diff --stat
```

zwróciło pusty wynik.

### Wynik

Lokalny `HEAD` jest dokładnie weryfikowanym commitem.

---

## 4.3. Lokalny `origin/main`

### Dowód z lokalnej referencji śledzącej

```text
git rev-parse origin/main
07cb3c16007833fd99b18f980829b356f694e67c
```

### Dowód z remote

```text
git ls-remote origin refs/heads/main
07cb3c16007833fd99b18f980829b356f694e67c    refs/heads/main
```

### Wynik

Lokalny `origin/main` oraz bezpośredni odczyt remote wskazują dokładnie ten sam
SHA co lokalny `HEAD`.

Etap:

```text
lokalny HEAD → origin/main / push
```

jest zgodny.

---

## 4.4. GitHub

### Commit API

GitHub API zwróciło:

```json
{
  "sha": "07cb3c16007833fd99b18f980829b356f694e67c",
  "message": "Add Selected Engine diagnostics",
  "html_url": "https://github.com/shopreebo-coder/ji-trading-bot-simple/commit/07cb3c16007833fd99b18f980829b356f694e67c",
  "files": [
    "telemetry/managers/SelectedEngineManager.js",
    "telemetry/public/index.html",
    "telemetry/server.js"
  ]
}
```

### Branch API

```json
{
  "ref": "refs/heads/main",
  "sha": "07cb3c16007833fd99b18f980829b356f694e67c"
}
```

### Wynik

GitHub `main` wskazuje ten sam commit co lokalny `HEAD` i `origin/main`.

Etap:

```text
origin/main → GitHub main
```

jest zgodny.

---

## 4.5. Railway Deploy

### Informacja przekazana przez użytkownika

Użytkownik poinformował:

```text
Railway potwierdza, że commit "Add Selected Engine diagnostics" został wdrożony pomyślnie (Deployment successful via GitHub).
```

### Odczyt metadanych dostępny w audycie

```json
{
  "success": true,
  "isDeployed": false,
  "hasSuccessfulBuild": false,
  "primaryUrl": "",
  "deploymentType": "",
  "additionalUrls": [],
  "visibility": ""
}
```

### Odczyt logów Railway

```text
No deployment logs found.
```

To samo wyszukiwanie po SHA i markerach diagnostycznych również nie zwróciło
logów:

```text
No deployment logs found.
```

### Brakujące dane

Nie uzyskano:

```text
Railway deployment ID
Railway build ID
Railway deployment commit SHA
Railway service ID
Railway environment ID
produkcjonalnego URL
logu pobrania commita
logu startowego kontenera produkcyjnego
```

### Wynik

Na podstawie danych dostępnych narzędziowo nie można potwierdzić, że Railway
pobrał i uruchomił dokładnie:

```text
07cb3c16007833fd99b18f980829b356f694e67c
```

Nie można też wskazać innego SHA, który Railway miałby uruchomić.

Status tego etapu:

```text
niezależnie niepotwierdzony
```

Jest to pierwsze miejsce w łańcuchu, którego nie dało się zamknąć dowodem
odczytowym.

---

## 4.6. Running Container

### Workflow

Konfigurowany workflow:

```text
Telemetry Dashboard
```

Komenda:

```text
PORT=8083 SHADOW_LAB_RESEARCH=on KNOWLEDGE_LAYER=on SELECTED_ENGINE=on SELECTED_ADVISOR=on TELEMETRY_RECONCILER=on node telemetry/server.js
```

Log workflow:

```text
/tmp/logs/Telemetry_Dashboard_20260731_084132_710_a66df52b.log
```

### Stan workflow

```text
workflow: Telemetry Dashboard
status: RUNNING
run_id: rffxECx20VKxzZmDgsg0H
timestamp: 2026-07-31T08:41:32.710Z
```

### Provenance endpointu

`GET /api/selected/status` oraz `GET /api/selected/context` zwracały:

```json
{
  "systemVersion": "v40.1",
  "provenance": {
    "runId": "092e9cda-52a1-4b70-b7f3-8e0288c5a7dd",
    "buildId": "v40.1+07cb3c160078",
    "configHash": "7425a852943c845d1c5d986622f79b41f54587e47d125b5230de20048d0bd09d"
  }
}
```

### Znaczenie `buildId`

Wartość:

```text
v40.1+07cb3c160078
```

zawiera skrócony identyfikator weryfikowanego commita:

```text
07cb3c1
```

Jest to silny dowód, że bieżący proces/workflow uruchomił wersję zawierającą
patch diagnostyczny.

Nie jest to jednak niezależny dowód, że ten sam proces jest kontenerem
produkcyjnym Railway. Dostępne dane określają go jako bieżący workflow
Telemety Dashboard.

### Stan Selected Engine

Odczyt lokalnego endpointu pokazał:

```text
builds = 6
lastBuildAt = 2026-07-31T08:29:02.845Z
lastError = null
```

W późniejszym odczycie kontekstu liczniki diagnostyczne wynosiły:

```text
DecisionContext_build_started = 212
DecisionContext_build_success = 212
DecisionContext_build_failed = 0
```

### Wynik

Patch jest aktywny w bieżącym kontenerze/workflow. Nie można utożsamić tego
dowodu z produkcyjnym kontenerem Railway bez produkcyjnego logu lub metadanych
deploymentu.

---

## 4.7. Dashboard

### Plik dashboardu

```text
telemetry/public/index.html
```

Dashboard jest pojedynczym ręcznie utrzymywanym plikiem HTML z React UMD
i Babel standalone. Jest serwowany przez ten sam proces co endpointy:

```text
telemetry/server.js
```

Routing:

```js
app.use(express.static(path.join(__dirname, "public")));
app.get("/", async (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
```

### Tab

`SELECTED` znajduje się w:

```js
const TABS = [
  "LIVE",
  "ANALIZA",
  "PIPELINE",
  "WYKRESY",
  "DECYZJE",
  "WZORCE",
  "EXCURSION",
  "INSIGHTS",
  "BLOCKED",
  "FILTERED",
  "LAB",
  "KNOWLEDGE",
  "SELECTED",
  "MODUŁY",
  "EXPORT"
];
```

### Stan React

```js
const [selected, setSelected] = useState(null);
```

### Pobieranie danych

Funkcja:

```js
async function refreshSelected()
```

wykonuje równolegle:

```text
GET /api/selected/status
GET /api/selected/context
```

Po poprawnym zakończeniu obu żądań wykonuje:

```js
setSelected({
  status: st,
  context: cx && cx.context,
  contextDiagnostics: cx && cx.diagnostics,
  contextSource: cx && cx.source,
});
```

### Odświeżanie globalne

Funkcja `refresh()` wykonuje sześć podstawowych żądań:

```text
/api/today
/api/stats
/api/symbols
/api/trades
/api/winrate-analysis
/api/confirmation-lag
```

Jeżeli wszystkie zakończą się powodzeniem, wywołuje:

```js
refreshSelected()
```

Globalne odświeżanie jest ustawione na:

```text
co 30 sekund
```

### Odświeżanie po wejściu na zakładkę

W `useEffect(..., [tab])` istnieje:

```js
if (tab === "SELECTED") refreshSelected();
```

### Renderowanie

Komponent:

```js
function SelectedTab({ data })
```

renderuje:

```text
data.contextSource
diagnostics.Dashboard_latestContext_source
diagnostics.Dashboard_latestContext_timestamp
diagnostics.Dashboard_latestContext_signalId
diagnostics.cooperativeSignal_sent
diagnostics.cooperativeSignal_success
diagnostics.cooperativeSignal_failed
diagnostics.DecisionContext_build_started
diagnostics.DecisionContext_build_success
diagnostics.DecisionContext_build_failed
```

### Najważniejszy warunek UI

`setSelected()` wykona się tylko wtedy, gdy oba żądania `Promise.all()`:

1. zostaną wysłane,
2. trafią do właściwego serwera,
3. zwrócą poprawny JSON,
4. nie odrzucą Promise.

Jeżeli jedno z nich odrzuci Promise, `setSelected()` nie zostanie wykonane.

### Wynik

Kod dashboardu zawiera zarówno pobieranie, jak i renderowanie nowych pól.
Nie ma dowodu na brak wiring-u w `telemetry/public/index.html`.

Nie udało się jednak potwierdzić z logów przeglądarki, że konkretna przeglądarka
użytkownika:

```text
wykonała oba żądania,
otrzymała JSON z właściwej instancji,
wykonała setSelected(),
wyrenderowała najnowszy stan.
```

---

## 5. Wszystkie zebrane dowody

## 5.1. Identyfikatory Git

```text
Commit:
07cb3c16007833fd99b18f980829b356f694e67c

Short commit:
07cb3c1

Message:
Add Selected Engine diagnostics

Local branch:
main

Remote branch:
origin/main

GitHub branch:
refs/heads/main
```

Wszystkie trzy referencje wskazywały ten sam pełny SHA:

```text
HEAD      = 07cb3c16007833fd99b18f980829b356f694e67c
origin/main = 07cb3c16007833fd99b18f980829b356f694e67c
GitHub main = 07cb3c16007833fd99b18f980829b356f694e67c
```

## 5.2. Pliki commita

```text
telemetry/managers/SelectedEngineManager.js
telemetry/public/index.html
telemetry/server.js
```

## 5.3. Identyfikatory procesu

```text
systemVersion:
v40.1

buildId:
v40.1+07cb3c160078

runId endpointu:
092e9cda-52a1-4b70-b7f3-8e0288c5a7dd

configHash:
7425a852943c845d1c5d986622f79b41f54587e47d125b5230de20048d0bd09d

workflow run_id:
rffxECx20VKxzZmDgsg0H

workflow timestamp:
2026-07-31T08:41:32.710Z
```

## 5.4. Endpointy odczytane

```text
GET /api/selected/status
GET /api/selected/context
```

Endpointy powiązane ze ścieżką:

```text
POST /api/cooperative/signal
POST /api/cooperative/entry
POST /api/cooperative/advisory
GET /api/selected/engines
GET /api/selected/contexts
GET /api/selected/context/:id
GET /api/selected/advisories
```

## 5.5. Odpowiedź `/api/selected/context`

Najważniejsze pola:

```text
ok = true
source = ring_buffer
```

Diagnostyka:

```text
DecisionContext_build_started = 212
DecisionContext_build_success = 212
DecisionContext_build_failed = 0
cooperativeSignal_sent = 211
cooperativeSignal_success = 211
cooperativeSignal_failed = 0
Dashboard_latestContext_timestamp = 2026-07-31T08:41:49.933Z
Dashboard_latestContext_signalId = 0f1b85b0-8459-4ef1-bc22-044708f4b887
Dashboard_latestContext_source = ring_buffer
```

Kontekst zawierał między innymi:

```text
schemaVersion
id
timestamp
symbol
setupId
liveSignal
engines
knowledge
confidence
expectancy
market
patterns
agreementScore
disagreementScore
consensus
consensusDetail
selectedReason
explainability
ranking
evidenceTrace
metadata
```

## 5.6. Odpowiedź `/api/selected/status`

Najważniejsze pola:

```text
selectedEnabled
running
ring
engineCount
engines
knowledgeDomains
knowledgeCount
knowledgeVersion
snapshot
stats
diagnostics
telemetry
systemVersion
provenance
```

Przykładowe dane:

```text
systemVersion = v40.1
buildId = v40.1+07cb3c160078
stats.builds = 6
stats.lastBuildAt = 2026-07-31T08:29:02.845Z
stats.lastError = null
```

## 5.7. Logi workflow

Plik:

```text
/tmp/logs/Telemetry_Dashboard_20260731_084132_710_a66df52b.log
```

Status:

```text
workflow: Telemetry Dashboard
status: RUNNING
run_id: rffxECx20VKxzZmDgsg0H
timestamp: 2026-07-31T08:41:32.710Z
```

W logu widoczne były między innymi:

```text
[ENGINE_C] Dataset cached: 1 historical pair(s)
Open trades error Request failed with status code 400
Spread error EUR_USD Request failed with status code 400
Candles error EUR_USD Request failed with status code 401
Spread error GBP_USD Request failed with status code 400
Candles error GBP_USD Request failed with status code 401
Spread error USD_JPY Request failed with status code 400
Candles error USD_JPY Request failed with status code 401
Spread error XAU_USD Request failed with status code 400
Candles error XAU_USD Request failed with status code 401
```

Te błędy dotyczą dostępu do OANDA/live market data w bieżącym workflow. Nie
wykazały błędu patcha diagnostycznego, ponieważ endpointy Selected Engine
zwracały poprawne liczniki i kontekst.

## 5.8. Brak logów produkcyjnych

Odczyt logów deploymentu zwrócił:

```text
No deployment logs found.
```

Brak było również nowych logów przeglądarki:

```text
No browser console logs / no new content
```

## 5.9. Checksumy z wcześniejszej walidacji

Z wcześniejszej walidacji zapisanej w stanie projektu:

```text
index.js:
a7dabdd79bd037fcf7656b7c33c54a29b4f7f721e0bf652fce328d8184374d7e

telemetry/shadowm.js:
18cd9c0f5acb960a71a03d7871ef00384963dc9510f077ce9a823fca49f68319
```

Wcześniejsza walidacja wykazała:

```text
Selected Engine tests: 25/25 passed
node --check zmienionych plików: passed
```

Te checksumy i wyniki są dowodami pomocniczymi z wcześniejszego audytu, nie
nowymi zmianami wykonanymi w ramach tego raportu.

---

## 6. Wszystkie znalezione rozbieżności

## 6.1. Rozbieżność między informacją Railway a odczytem metadanych

### Informacja użytkownika

```text
Deployment successful via GitHub
```

### Odczyt narzędziowy

```text
isDeployed = false
hasSuccessfulBuild = false
primaryUrl = ""
No deployment logs found.
```

### Interpretacja

Nie można stwierdzić, czy:

1. narzędzie odczytu ma dostęp do tego samego projektu/usługi Railway,
2. deployment nie jest widoczny w bieżącym kontekście narzędziowym,
3. deployment istnieje, ale nie ma dostępnych logów,
4. użytkownik obserwuje inny Railway project/environment/service,
5. deployment zakończył się sukcesem, ale późniejszy stan metadanych nie jest
   dostępny.

Nie ma wystarczających danych, aby wybrać jedną z tych hipotez.

## 6.2. Rozbieżność między potwierdzonym running container a produkcją

Potwierdzony proces:

```text
Telemetry Dashboard workflow
buildId = v40.1+07cb3c160078
```

Niepotwierdzony proces:

```text
Railway production container
```

Brakuje wspólnego, niezależnego identyfikatora deploymentu lub logu startowego,
który łączyłby te dwa procesy.

## 6.3. Brak dowodu po stronie przeglądarki

Backend zwraca nowe dane, ale nie ma dowodu, że właściwa przeglądarka Railway:

```text
wykonała /api/selected/status
wykonała /api/selected/context
otrzymała JSON
wykonała setSelected()
wyrenderowała SelectedTab z nowym stanem
```

## 6.4. Możliwe zatrzymanie ścieżki przez `refresh()`

Globalny cykl wykonuje najpierw:

```text
/api/today
/api/stats
/api/symbols
/api/trades
/api/winrate-analysis
/api/confirmation-lag
```

Następnie dopiero wywołuje `refreshSelected()`.

Jeżeli dowolny z sześciu podstawowych endpointów odrzuci Promise, globalny
cykl nie dotrze do `refreshSelected()`. Kod ma osobną ścieżkę po przejściu na
zakładkę `SELECTED`, więc ta hipoteza nie wyjaśniałaby braku danych po
bezpośrednim wejściu na tę zakładkę, ale jest możliwym wyjaśnieniem braku
odświeżania w cyklu globalnym.

## 6.5. Ciche odrzucanie wysyłki z Live Bota

W `index.js`, funkcja `cooperativeSignal()` wykonuje:

```js
axios.post(...).catch(() => {});
```

Błąd po stronie klienta Live Bota jest więc cicho odrzucany. Licznik:

```text
cooperativeSignal_failed
```

nie obejmuje wszystkich nieudanych prób wysłania z klienta. Obejmuje tylko
wyjątek w serwerowym handlerze `/api/cooperative/signal`.

Nie jest to rozbieżność wersji, ale ograniczenie wartości diagnostycznej tego
licznika.

## 6.6. Różnica między licznikiem buildów a licznikiem sygnałów

Odczyt:

```text
build_started = 212
cooperativeSignal_sent = 211
```

Nie jest sam w sobie błędem. `buildDecisionContext()` może być wywoływany
również przez:

```text
start() — initial build
polling w tle
/api/cooperative/entry
/api/selected/context?signalId=...
```

Dlatego licznik buildów nie musi być równy licznikowi signal notify.

---

## 7. Co zostało potwierdzone

Potwierdzono wszystkie poniższe punkty:

### Git i repozytorium

- Commit `07cb3c16007833fd99b18f980829b356f694e67c` istnieje lokalnie.
- Message commita to `Add Selected Engine diagnostics`.
- Lokalny `HEAD` wskazuje ten commit.
- Lokalny branch to `main`.
- Lokalny `origin/main` wskazuje ten commit.
- `git ls-remote origin refs/heads/main` wskazuje ten commit.
- GitHub API potwierdza ten commit.
- GitHub `refs/heads/main` wskazuje ten commit.
- Commit zmienia trzy oczekiwane pliki.
- Nie wykazano lokalnych niezacommitowanych zmian.

### Kod backendu

- Liczniki `DecisionContext_build_started`, `success`, `failed` istnieją.
- Licznik startuje na wejściu do `buildDecisionContext()`.
- Licznik sukcesu rośnie po poprawnym `_buildDecisionContext()`.
- Licznik błędu rośnie po wyjątku.
- Błąd builda jest logowany przez `[SELECTED DIAG]`.
- Eventy `cooperativeSignal_sent`, `success`, `failed` są zapisywane przez
  `logEvent()`.
- `selectedCommunicationCounters()` odczytuje te eventy z tabeli `events`.
- `/api/selected/status` udostępnia scalone liczniki.
- `/api/selected/context` udostępnia scalone liczniki.
- `/api/selected/context` bez `signalId` odczytuje najnowszy kontekst z ring
  buffera.
- Explicit `signalId` zachowuje ścieżkę rebuild z bazy.
- `Dashboard_latestContext_*` są aktualizowane podczas obsługi
  `/api/selected/context`.

### Bieżący workflow

- Workflow `Telemetry Dashboard` działa.
- Bieżący proces odpowiada na endpointy Selected Engine.
- Bieżący proces publikuje `buildId` zawierający `07cb3c1`.
- `DecisionContext_build_started = 212`.
- `DecisionContext_build_success = 212`.
- `DecisionContext_build_failed = 0`.
- `cooperativeSignal_sent = 211`.
- `cooperativeSignal_success = 211`.
- `cooperativeSignal_failed = 0`.
- Ring buffer zawiera kontekst.
- `source = ring_buffer`.
- `lastError = null`.

### Dashboard

- Tab `SELECTED` istnieje.
- `refreshSelected()` istnieje.
- Dashboard pobiera `/api/selected/status`.
- Dashboard pobiera `/api/selected/context`.
- Dashboard zapisuje odpowiedź do `selected`.
- `SelectedTab` renderuje nowe pola diagnostyczne.
- Dashboard ma ścieżkę odświeżania co 30 sekund.
- Dashboard ma ścieżkę odświeżenia po wejściu na tab `SELECTED`.

---

## 8. Czego nie udało się potwierdzić

Nie udało się potwierdzić:

1. Railway deployment ID dla commita
   `07cb3c16007833fd99b18f980829b356f694e67c`.
2. Railway build ID dla tego deploymentu.
3. Railway commit SHA przypisanego do konkretnego deploymentu.
4. Logu Railway pokazującego checkout commita.
5. Logu startowego produkcyjnego kontenera zawierającego:
   ```text
   07cb3c1
   ```
   albo:
   ```text
   v40.1+07cb3c160078
   ```
6. Publicznego URL-a produkcyjnego.
7. Niezależnego dowodu, że bieżący workflow `Telemetry Dashboard` jest tym samym
   procesem co produkcyjny kontener Railway.
8. Odpowiedzi endpointów z właściwego publicznego Railway deploymentu.
9. Logów konsoli przeglądarki dla konkretnego dashboardu użytkownika.
10. Dowodu, że przeglądarka wykonała oba żądania w `refreshSelected()`.
11. Dowodu, że `setSelected()` wykonał się w przeglądarce.
12. Dowodu, że problem „dashboard pozostaje bez zmian” występuje w kodzie
    `SelectedTab`, a nie przed renderowaniem.
13. Dowodu, że sześć podstawowych endpointów w globalnym `refresh()` zawsze
    kończy się sukcesem w środowisku, w którym użytkownik ogląda dashboard.
14. Pełnego produkcyjnego logu wysłania `signal_detected` przez Live Bota.
15. Pełnej telemetrii błędów klienta `axios.post()` z `index.js`, ponieważ
    `.catch(() => {})` je odrzuca bez logowania.

---

## 9. Warunki wykonania całej ścieżki diagnostycznej

Poniższa tabela podsumowuje wszystkie istotne punkty.

| Etap | Plik | Funkcja/handler | Warunek | Wynik audytu |
|---|---|---|---|---|
| Utworzenie liczników | `telemetry/managers/SelectedEngineManager.js` | `constructor()` | Proces tworzy `SelectedEngineManager` | Potwierdzone |
| Start build counter | `telemetry/managers/SelectedEngineManager.js` | `buildDecisionContext()` | Dowolne wywołanie builda | Potwierdzone |
| Success counter | `telemetry/managers/SelectedEngineManager.js` | `buildDecisionContext()` | `_buildDecisionContext()` kończy się bez wyjątku | Potwierdzone |
| Failed counter | `telemetry/managers/SelectedEngineManager.js` | `buildDecisionContext()` | `_buildDecisionContext()` rzuca wyjątek | Nie zachodzi; `0` |
| Ring buffer | `telemetry/managers/SelectedEngineManager.js` | `_store()` | Kontekst ma niepuste `id` | Potwierdzone |
| Signal sent | `telemetry/server.js` | `POST /api/cooperative/signal` | Żądanie dociera do handlera | Potwierdzone |
| Signal success | `telemetry/server.js` | `POST /api/cooperative/signal` | Handler wykonuje odpowiedź 200 | Potwierdzone |
| Signal failed | `telemetry/server.js` | `POST /api/cooperative/signal` | Handler rzuca synchroniczny wyjątek | Nie zachodzi; `0` |
| Fresh context | `telemetry/server.js` | `POST /api/cooperative/signal` | `SELECTED_ENGINE_ENABLED` jest `true` | Potwierdzone w workflow |
| Status API | `telemetry/server.js` | `GET /api/selected/status` | `getStatus()` i query counters nie rzucają | Potwierdzone |
| Context API | `telemetry/server.js` | `GET /api/selected/context` | Ring buffer zawiera kontekst | Potwierdzone |
| Dashboard fetch | `telemetry/public/index.html` | `refreshSelected()` | Oba GET-y zwracają poprawny JSON | Niepotwierdzone dla produkcyjnej przeglądarki |
| Dashboard state | `telemetry/public/index.html` | `setSelected()` | `Promise.all()` nie odrzuca | Niepotwierdzone dla produkcyjnej przeglądarki |
| Dashboard render | `telemetry/public/index.html` | `SelectedTab()` | `tab === "SELECTED"` i `data !== null` | Kod potwierdzony; wykonanie w przeglądarce nie |
| Railway runtime | Railway | production container | Deployment/build/runtime ma SHA patcha | Niepotwierdzone narzędziowo |

---

## 10. Wniosek końcowy

### Wniosek techniczny

Patch diagnostyczny jest obecny w:

```text
lokalnym HEAD
origin/main
GitHub main
bieżącym workflow Telemetry Dashboard
```

Bieżący workflow uruchamia:

```text
buildId = v40.1+07cb3c160078
```

Backendowa ścieżka diagnostyczna działa:

```text
cooperative signal
  → event sent/success
  → DecisionContext build
  → ring buffer
  → /api/selected/context
  → diagnostyczne pola
```

Nie znaleziono backendowego warunku, który obecnie blokowałby aktualizację
diagnostyki w tej instancji.

### Pierwszy niezamknięty etap wdrożenia

Pierwszym etapem bez niezależnego dowodu jest:

```text
GitHub main → Railway deployment
```

Powód:

```text
isDeployed = false
hasSuccessfulBuild = false
primaryUrl = ""
No deployment logs found.
```

Pozostaje to w sprzeczności z przekazanym potwierdzeniem:

```text
Deployment successful via GitHub
```

### Pierwszy niepotwierdzony warunek dashboardu

Po stronie dashboardu pierwszym niepotwierdzonym warunkiem jest:

```text
refreshSelected() musi skutecznie wykonać oba GET-y
i dojść do setSelected() w tej samej instancji Railway,
którą ogląda użytkownik.
```

Jeżeli problem dotyczy tylko globalnego odświeżania, dodatkowym wcześniejszym
warunkiem jest poprawne zakończenie wszystkich sześciu żądań w `refresh()`.

### Ostateczna klasyfikacja

```text
Lokalny commit:       POTWIERDZONY
Lokalny HEAD:         POTWIERDZONY
origin/main:          POTWIERDZONY
GitHub main:          POTWIERDZONY
Patch w running app:  POTWIERDZONY dla bieżącego workflow
Railway deploy SHA:   NIEPOTWIERDZONY narzędziowo
Production container: NIEPOTWIERDZONY narzędziowo
Backend diagnostics:  POTWIERDZONE DZIAŁANIE
Dashboard wiring:     POTWIERDZONE W KODZIE
Dashboard browser run: NIEPOTWIERDZONY
```

Raport nie wskazuje błędu, którego można naprawić bezpośrednio w kodzie
na podstawie dostępnych dowodów. Wskazuje natomiast dokładną granicę
weryfikowalności: między GitHub a Railway oraz między backendowym endpointem
a wykonaniem `refreshSelected()` w konkretnej przeglądarce produkcyjnej.
