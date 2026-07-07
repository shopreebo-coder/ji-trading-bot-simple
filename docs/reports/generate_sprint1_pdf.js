"use strict";
/**
 * Generates docs/reports/SPRINT_1_REPORT.pdf from SPRINT_1_REPORT.md
 * Run: node docs/reports/generate_sprint1_pdf.js
 */

const PDFDocument = require("pdfkit");
const fs          = require("fs");
const path        = require("path");

const OUTPUT = path.join(__dirname, "SPRINT_1_REPORT.pdf");

const C = {
  black:     "#1a1a1a",
  darkGray:  "#2d2d2d",
  midGray:   "#555555",
  lightGray: "#888888",
  border:    "#cccccc",
  bg:        "#f5f5f5",
  green:     "#1a7340",
  greenBg:   "#e8f5ee",
  red:       "#c0392b",
  blue:      "#1a4a7a",
  blueBg:    "#e8f0fa",
  accent:    "#2c5f8a",
  white:     "#ffffff",
  tableHead: "#2c5f8a",
  tableRow:  "#f9f9f9",
  tableAlt:  "#ffffff",
};

const F = {
  regular:  "Helvetica",
  bold:     "Helvetica-Bold",
  italic:   "Helvetica-Oblique",
  mono:     "Courier",
  monoBold: "Courier-Bold",
};

const PAGE_W   = 612;
const PAGE_H   = 792;
const MARGIN   = 50;
const CONTENT_W = PAGE_W - MARGIN * 2;

const doc = new PDFDocument({
  size:    "LETTER",
  margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
  info: {
    Title:    "Sprint 1 Report — SHADOW OS v2 Runtime Awakening",
    Author:   "FOREX ENGINE PRO — Automated Report",
    Subject:  "SHADOW OS v2 Migration Sprint 1",
    Keywords: "sprint,migration,postgresql,shadow-os,forex,RuntimeDomainManager",
    Creator:  "generate_sprint1_pdf.js (pdfkit)",
  },
  autoFirstPage: false,
});

doc.pipe(fs.createWriteStream(OUTPUT));

let pageNum = 0;
let y       = MARGIN;

function newPage() {
  doc.addPage();
  pageNum++;
  y = MARGIN;
  doc.save().rect(0, 0, PAGE_W, 32).fill(C.accent).restore();
  doc.font(F.bold).fontSize(8).fillColor(C.white)
     .text("FOREX ENGINE PRO  |  SHADOW OS v2  |  Sprint 1: Runtime Awakening", MARGIN, 11);
  doc.font(F.regular).fontSize(8).fillColor(C.white)
     .text(`Page ${pageNum}`, PAGE_W - MARGIN - 50, 11, { width: 50, align: "right" });
  y = 48;
}

function checkY(needed) {
  if (y + needed > PAGE_H - MARGIN - 20) newPage();
}

function hRule(color = C.border, thick = 0.5) {
  doc.save().moveTo(MARGIN, y).lineTo(PAGE_W - MARGIN, y)
     .lineWidth(thick).strokeColor(color).stroke().restore();
  y += 6;
}

function vSpace(n = 8) { y += n; }

function h1(text) {
  checkY(60);
  vSpace(14);
  doc.save().rect(MARGIN, y, 4, 22).fill(C.accent).restore();
  doc.font(F.bold).fontSize(16).fillColor(C.accent)
     .text(text, MARGIN + 12, y, { width: CONTENT_W - 12 });
  y += 26;
  hRule(C.accent, 1);
}

function h2(text) {
  checkY(42);
  vSpace(10);
  doc.font(F.bold).fontSize(12).fillColor(C.darkGray)
     .text(text, MARGIN, y, { width: CONTENT_W });
  y += 16;
  hRule(C.border);
}

function h3(text) {
  checkY(28);
  vSpace(6);
  doc.font(F.bold).fontSize(10).fillColor(C.accent)
     .text(text, MARGIN, y, { width: CONTENT_W });
  y += 14;
}

function para(text, opts = {}) {
  const fontSize = opts.fontSize || 9;
  const color    = opts.color    || C.black;
  const indent   = opts.indent   || 0;
  const font     = opts.font     || F.regular;
  doc.font(font).fontSize(fontSize).fillColor(color);
  const h = doc.heightOfString(text, { width: CONTENT_W - indent });
  checkY(h + 4);
  doc.text(text, MARGIN + indent, y, { width: CONTENT_W - indent });
  y += h + 4;
}

function bullet(text, level = 0) {
  const indent = 12 + level * 14;
  const bc     = level === 0 ? "•" : "–";
  doc.font(F.regular).fontSize(9).fillColor(C.midGray);
  const bW   = doc.widthOfString(bc + " ");
  const textW = CONTENT_W - indent - bW;
  const h    = doc.heightOfString(text, { width: textW });
  checkY(h + 3);
  doc.text(bc, MARGIN + indent, y);
  doc.font(F.regular).fontSize(9).fillColor(C.black)
     .text(text, MARGIN + indent + bW, y, { width: textW });
  y += h + 3;
}

function codeBlock(text) {
  const lines   = text.split("\n");
  const lineH   = 11;
  const padding = 8;
  const totalH  = lines.length * lineH + padding * 2;
  checkY(totalH + 8);
  doc.save().rect(MARGIN, y, CONTENT_W, totalH).fill(C.bg).restore();
  doc.save().rect(MARGIN, y, CONTENT_W, totalH).lineWidth(0.5).strokeColor(C.border).stroke().restore();
  doc.save().rect(MARGIN, y, 3, totalH).fill(C.accent).restore();
  let cy = y + padding;
  for (const line of lines) {
    doc.font(F.mono).fontSize(7.5).fillColor(C.darkGray)
       .text(line, MARGIN + 10, cy, { width: CONTENT_W - 14, lineBreak: false });
    cy += lineH;
  }
  y = y + totalH + 6;
}

function table(headers, rows, colWidths) {
  const rowH    = 18;
  const headH   = 20;
  const padding = 5;
  const totalW  = colWidths.reduce((a, b) => a + b, 0);
  checkY(headH + rowH + 10);
  doc.save().rect(MARGIN, y, totalW, headH).fill(C.tableHead).restore();
  let cx = MARGIN;
  for (let i = 0; i < headers.length; i++) {
    doc.font(F.bold).fontSize(8).fillColor(C.white)
       .text(headers[i], cx + padding, y + 6, { width: colWidths[i] - padding * 2, lineBreak: false });
    cx += colWidths[i];
  }
  y += headH;
  for (let r = 0; r < rows.length; r++) {
    const row  = rows[r];
    const bg   = r % 2 === 0 ? C.tableRow : C.tableAlt;
    let maxH   = rowH;
    cx = MARGIN;
    for (let c = 0; c < row.length; c++) {
      const cellH = doc.font(F.regular).fontSize(8)
                       .heightOfString(String(row[c] || ""), { width: colWidths[c] - padding * 2 });
      if (cellH + 8 > maxH) maxH = cellH + 8;
      cx += colWidths[c];
    }
    checkY(maxH + 2);
    doc.save().rect(MARGIN, y, totalW, maxH).fill(bg).restore();
    cx = MARGIN;
    for (let c = 0; c < row.length; c++) {
      const cellText = String(row[c] || "");
      let cellColor  = C.black;
      if (cellText.includes("✅") || cellText.includes("PASS")) cellColor = C.green;
      if (cellText.includes("✗") || cellText.includes("FAIL"))   cellColor = C.red;
      doc.font(F.regular).fontSize(8).fillColor(cellColor)
         .text(cellText, cx + padding, y + 5, { width: colWidths[c] - padding * 2, lineBreak: true });
      cx += colWidths[c];
    }
    doc.save().moveTo(MARGIN, y + maxH).lineTo(MARGIN + totalW, y + maxH)
       .lineWidth(0.3).strokeColor(C.border).stroke().restore();
    y += maxH;
  }
  doc.save().rect(MARGIN, y - (rows.length * rowH + headH), totalW, rows.length * rowH + headH)
     .lineWidth(0.5).strokeColor(C.border).stroke().restore();
  y += 10;
}

function callout(text, color = C.accent, bgColor = C.blueBg) {
  const h = doc.font(F.italic).fontSize(9).heightOfString(text, { width: CONTENT_W - 20 });
  const totalH = h + 20;
  checkY(totalH + 6);
  doc.save().rect(MARGIN, y, CONTENT_W, totalH).fill(bgColor).restore();
  doc.save().rect(MARGIN, y, 4, totalH).fill(color).restore();
  doc.font(F.italic).fontSize(9).fillColor(C.darkGray)
     .text(text, MARGIN + 14, y + 10, { width: CONTENT_W - 20 });
  y += totalH + 6;
}

// ── COVER PAGE ────────────────────────────────────────────────────────────
doc.addPage();
pageNum++;

doc.save().rect(0, 0, PAGE_W, 220).fill(C.accent).restore();
doc.save().rect(0, 220, PAGE_W, 8).fill(C.green).restore();

doc.font(F.bold).fontSize(28).fillColor(C.white)
   .text("FOREX ENGINE PRO", MARGIN, 55, { width: CONTENT_W, align: "center" });
doc.font(F.regular).fontSize(13).fillColor("#aacce8")
   .text("SHADOW OS v2 Migration Program", MARGIN, 93, { width: CONTENT_W, align: "center" });

doc.save().roundedRect(PAGE_W / 2 - 80, 128, 160, 36, 6).fill(C.green).restore();
doc.font(F.bold).fontSize(16).fillColor(C.white)
   .text("SPRINT 1", PAGE_W / 2 - 80, 137, { width: 160, align: "center" });
doc.font(F.regular).fontSize(9).fillColor("#d0f0e0")
   .text("Runtime Awakening", PAGE_W / 2 - 80, 155, { width: 160, align: "center" });

doc.save().roundedRect(PAGE_W / 2 - 65, 180, 130, 26, 4).fill("#27ae60").restore();
doc.font(F.bold).fontSize(11).fillColor(C.white)
   .text("✅  SPRINT COMPLETE", PAGE_W / 2 - 65, 187, { width: 130, align: "center" });

doc.save().rect(MARGIN, 248, CONTENT_W, 140).fill(C.bg).restore();
doc.save().rect(MARGIN, 248, CONTENT_W, 140).lineWidth(0.5).strokeColor(C.border).stroke().restore();

const metaRows = [
  ["Date",           "2026-07-06"],
  ["Sprint Name",    "Runtime Awakening"],
  ["Component",      "RuntimeDomainManager"],
  ["Database",       "heliumdb — PostgreSQL 16.10 (Railway)"],
  ["Tests",          "107/107 PASS (61 unit + 11 integration + 25 simulation + 10 stress)"],
  ["Sprint 0 Reg.",  "19/19 PASS (unchanged)"],
  ["Production",     "Live bot UNCHANGED — 0 production files modified"],
  ["Sacred Constr.", "HONORED — 0 rows of knowledge lost"],
];

let my = 258;
for (const [k, v] of metaRows) {
  doc.font(F.bold).fontSize(8.5).fillColor(C.midGray)
     .text(k + ":", MARGIN + 14, my, { width: 90, lineBreak: false });
  doc.font(F.mono).fontSize(8.5).fillColor(C.darkGray)
     .text(v, MARGIN + 108, my, { width: CONTENT_W - 120, lineBreak: false });
  my += 16;
}

const metrics = [
  ["107", "Tests\nPassed"],
  ["0",   "Tests\nFailed"],
  ["19",  "API\nMethods"],
  ["25",  "Simulations\nPassed"],
  ["0",   "Prod Files\nModified"],
];

let mx   = MARGIN;
const mBoxW = CONTENT_W / metrics.length;
const mY = 412;

doc.save().rect(MARGIN, mY, CONTENT_W, 80).fill(C.blueBg).restore();
doc.save().rect(MARGIN, mY, CONTENT_W, 80).lineWidth(0.5).strokeColor(C.border).stroke().restore();

for (const [num, label] of metrics) {
  doc.font(F.bold).fontSize(22).fillColor(C.accent)
     .text(num, mx, mY + 14, { width: mBoxW, align: "center" });
  doc.font(F.regular).fontSize(7.5).fillColor(C.midGray)
     .text(label, mx, mY + 42, { width: mBoxW, align: "center" });
  mx += mBoxW;
}

doc.font(F.regular).fontSize(8).fillColor(C.lightGray)
   .text(
     "FOREX ENGINE PRO  |  Sprint 1 Report  |  SHADOW OS v2 — Runtime Awakening  |  RuntimeDomainManager",
     MARGIN, PAGE_H - MARGIN - 20, { width: CONTENT_W, align: "center" }
   );

// ── CONTENT PAGES ─────────────────────────────────────────────────────────
newPage();

// 1. Executive Summary
h1("1. Executive Summary");
para(
  "Sprint 1 delivered RuntimeDomainManager — the first production component of SHADOW OS v2 and the " +
  "foundational layer on which all future Shadow Engines will communicate. RuntimeDomainManager is now " +
  "the single, authoritative owner of all 10 SHADOW OS v2 runtime domains."
);
vSpace(4);
para(
  "It enforces optimistic locking (compareAndSwap), records a full immutable version history of every " +
  "mutation, provides snapshot and rollback capabilities, and includes a consistency check system. " +
  "107 tests across 4 suites pass. Zero production files were modified."
);
vSpace(6);

checkY(40);
doc.save().rect(MARGIN, y, CONTENT_W, 34).fill(C.greenBg).restore();
doc.save().rect(MARGIN, y, 4, 34).fill(C.green).restore();
doc.font(F.bold).fontSize(8).fillColor(C.green)
   .text("Sacred Constraint — HONORED", MARGIN + 12, y + 5);
doc.font(F.italic).fontSize(8.5).fillColor(C.darkGray)
   .text(
     "No deployment, restart, or migration step destroyed the accumulated trading knowledge of the system.",
     MARGIN + 12, y + 17, { width: CONTENT_W - 20 }
   );
y += 42;

// 2. Objectives
h1("2. Objectives");
table(
  ["Phase", "Objective", "Status"],
  [
    ["1 — Design",    "MASTER_ARCHITECTURE.md — single source of truth", "✅ COMPLETE"],
    ["2 — Impl",      "RuntimeDomainManager — 19 public methods, full API", "✅ COMPLETE"],
    ["2 — Impl",      "Migration 002 — runtime_domain_history table", "✅ COMPLETE"],
    ["3 — Testing",   "61 unit tests — all public methods", "✅ 61/61 PASS"],
    ["3 — Testing",   "11 integration tests — concurrency, round-trips", "✅ 11/11 PASS"],
    ["4 — Simulation","25 simulation tests — 6 failure scenarios", "✅ 25/25 PASS"],
    ["3 — Stress",    "10 stress tests — throughput + concurrency", "✅ 10/10 PASS"],
    ["5 — Validation","Sprint 0 regression — 0 production files changed", "✅ 19/19 PASS"],
    ["6 — Docs",      "MASTER_ARCHITECTURE.md + PDF", "✅ COMPLETE"],
    ["6 — Docs",      "SPRINT_1_REPORT.md + PDF", "✅ COMPLETE"],
  ],
  [80, 318, 114]
);

// 3. Architecture
h1("3. MASTER_ARCHITECTURE.md");
para(
  "docs/architecture/MASTER_ARCHITECTURE.md is now the single source of truth for SHADOW OS v2. " +
  "It contains 15 sections covering the complete system architecture."
);
vSpace(4);
table(
  ["Section", "Content"],
  [
    ["1", "Purpose and Scope (Sacred Constraint formally stated)"],
    ["2", "Core Design Philosophy (6 Invariants)"],
    ["3", "Four-Layer Memory Hierarchy with ASCII diagrams"],
    ["4", "Complete Component Map — 14 components, responsibility table"],
    ["5", "All 10 Runtime Domain definitions with schemas"],
    ["6", "Manager Hierarchy — 5 managers, API contracts"],
    ["7", "Lifecycle Diagrams — startup, Railway restart, power failure"],
    ["8", "Data Flow Diagrams — trade open pre/post-v2, ShadowLab cycle"],
    ["9", "Component Interaction Matrix — who writes to what"],
    ["10","Complete Database Schema — 11 tables, 22 indexes"],
    ["11","API Contracts and error conventions"],
    ["12","Recovery Sequences — 9 phases, corruption recovery"],
    ["13","Failure Modes and Mitigations — 10 failure types"],
    ["14","Implementation Status table"],
    ["15","Sprint Roadmap — Sprints 0–6"],
  ],
  [40, 472]
);

// 4. Implementation
h1("4. Implementation");

h2("Files Created");
table(
  ["File", "Lines", "Purpose"],
  [
    ["telemetry/managers/RuntimeDomainManager.js", "530+", "Core implementation"],
    ["telemetry/managers/index.js", "19", "Barrel export"],
    ["telemetry/migrations/002_runtime_domain_history.sql", "52", "Schema migration (Sprint 1)"],
    ["docs/architecture/MASTER_ARCHITECTURE.md", "620+", "Architecture document"],
    ["telemetry/tests/unit/RuntimeDomainManager.test.js", "370+", "61 unit tests"],
    ["telemetry/tests/integration/rdm_integration.test.js", "180+", "11 integration tests"],
    ["telemetry/tests/simulation/rdm_simulation.test.js", "340+", "25 simulation tests"],
    ["telemetry/tests/stress/rdm_stress.test.js", "220+", "10 stress tests"],
  ],
  [282, 48, 182]
);

h2("RuntimeDomainManager API (19 public methods)");
codeBlock(
`Lifecycle:       init()  shutdown()

Core CRUD:       createDomain(domain, value, opts)     → { created, row }
                 getDomain(domain)                     → row | null
                 listDomains()                         → [ row, ... ]
                 updateDomain(domain, value, opts)      → row
                 patchDomain(domain, patch, opts)       → row

Optimistic lock: compareAndSwap(domain, expectedVer, val) → { swapped, currentVersion, row }

Snapshots:       takeSnapshot(reason, opts)            → { snapshotId, createdAt, domainCount }
                 getSnapshot(id)                       → row | null
                 listSnapshots(limit)                  → [ row, ... ]
                 restoreFromSnapshot(id, domains, opts) → { restored[], snapshotId }

Version history: getHistory(domain, limit)             → [ history_row, ... ]
                 rollback(domain, targetVersion, opts)  → { domain, rolledBackTo, currentVersion }

Audit:           logConsistency(checkId, severity, desc, detail, opts)
                 resolveConsistency(id, resolution, opts)
                 runConsistencyCheck()                 → { checks, domains, issues, severity }

Health:          ping()                                → { ok, latencyMs }
                 getStats()                            → { domains, maxVersion, historyRows, pool }`
);

h2("Production Files — Unchanged");
table(
  ["File", "Status"],
  [
    ["index.js (FROZEN)", "✅ 0 lines changed"],
    ["telemetry/server.js", "✅ 0 lines changed"],
    ["telemetry/shadowm.js", "✅ 0 lines changed"],
    ["telemetry/shadowlab.js", "✅ 0 lines changed"],
    ["telemetry/db-adapter.js", "✅ 0 lines changed"],
    ["telemetry/index.js", "✅ 0 lines changed"],
  ],
  [320, 192]
);

// 5. Database Changes
h1("5. Database Changes");

h2("Migration 002: runtime_domain_history");
codeBlock(
`CREATE TABLE IF NOT EXISTS runtime_domain_history (
  id          BIGSERIAL   PRIMARY KEY,
  domain      TEXT        NOT NULL,
  version     BIGINT      NOT NULL,
  value       JSONB       NOT NULL,
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  changed_by  TEXT        NOT NULL DEFAULT 'system',
  change_op   TEXT        NOT NULL
              CHECK (change_op IN ('CREATE','UPDATE','PATCH','CAS','RESTORE','ROLLBACK','SNAPSHOT')),
  snapshot_id BIGINT      REFERENCES system_snapshots(id) ON DELETE SET NULL,
  notes       TEXT
);
CREATE INDEX idx_rdh_domain_ver ON runtime_domain_history (domain, version DESC);
CREATE INDEX idx_rdh_changed_at ON runtime_domain_history (changed_at DESC);
CREATE INDEX idx_rdh_snapshot   ON runtime_domain_history (snapshot_id) WHERE snapshot_id IS NOT NULL;`
);

h2("Data Integrity (Sacred Constraint)");
table(
  ["Table", "Before", "After", "Status"],
  [
    ["events",          "29",  "29+", "✅ No data lost"],
    ["shadowm_trades",  "1",   "1+",  "✅ No data lost"],
    ["shadowm_timeline","0",   "0+",  "✅ No data lost"],
    ["runtime_domains", "10",  "10",  "✅ All 10 domains present"],
  ],
  [200, 60, 60, 192]
);

// 6. Test Results
h1("6. Test Results");

h2("Full Test Summary");
table(
  ["Suite", "Tests", "Pass", "Fail", "Duration"],
  [
    ["Unit",        "61",  "61",  "0", "~1.0s"],
    ["Integration", "11",  "11",  "0", "~0.6s"],
    ["Simulation",  "25",  "25",  "0", "~0.9s"],
    ["Stress",      "10",  "10",  "0", "~2.9s"],
    ["TOTAL",       "107", "107", "0", "~5.9s"],
    ["Sprint 0 Regression", "19", "19", "0", "—"],
  ],
  [160, 60, 60, 60, 172]
);

h2("Performance Benchmarks (Stress Tests)");
table(
  ["Operation", "Latency", "Throughput"],
  [
    ["getDomain()", "~2ms", "—"],
    ["updateDomain()", "4.9ms avg", "~200/s"],
    ["compareAndSwap() — success", "6.7ms avg", "~149/s"],
    ["patchDomain()", "4.4ms avg", "~227/s"],
    ["takeSnapshot() — 10 domains", "21ms", "—"],
    ["getHistory() — 100 entries", "2ms", "—"],
    ["ping()", "avg 2ms, max 3ms", "—"],
    ["100KB JSONB read", "6ms", "—"],
    ["20 concurrent domain updates", "252ms total", "—"],
  ],
  [220, 120, 172]
);

// 7. Simulations
h1("7. Simulation Results");

h2("6 Failure Scenarios — All Verified");
table(
  ["Scenario", "Tests", "Key Verification"],
  [
    ["SIM-1: Normal Startup",       "5", "All tables found, all 10 domains readable, ping < 200ms"],
    ["SIM-2: Railway Restart",      "5", "State/version/history survive re-init, snapshot restores"],
    ["SIM-3: Power Failure",        "4", "PG rollback preserves state, no orphan history entries"],
    ["SIM-4: Runtime Corruption",   "5", "Detected, logged CRITICAL, rolled back, resolved"],
    ["SIM-5: Version Conflict",     "3", "Exactly 1 CAS winner, loser retries with fresh version"],
    ["SIM-6: Database Reconnect",   "3", "Auto-reconnect, committed data preserved, history intact"],
  ],
  [180, 40, 292]
);

// 8. Bug Found and Fixed
h1("8. Key Finding — CAS Connection Deadlock");

callout(
  "A connection pool deadlock was discovered during simulation SIM-3C and fixed before any production " +
  "code uses RuntimeDomainManager. This is precisely why simulation testing exists.",
  C.accent, C.blueBg
);

vSpace(4);
h3("Root Cause");
para(
  "The original compareAndSwap() called this.getDomain() in the 'else' branch (CAS failure path) to " +
  "read the current domain state. getDomain() acquires a new pool connection. But the current client " +
  "connection is still held — the finally { client.release() } block runs after the return statement. " +
  "With N concurrent CAS operations and pool.max=N, all N connections are held, all N then try to acquire " +
  "an N+1th connection, and all N block permanently."
);
vSpace(4);
h3("Fix");
para(
  "Read the current domain state within the same client connection (while it is already held), then " +
  "do ROLLBACK, then return. This eliminates the need for a second connection on CAS failure."
);
vSpace(4);
h3("Lesson");
para(
  "Connection pool exhaustion deadlocks do not appear in sequential tests — only under concurrent load. " +
  "Stress and simulation testing with real pool constraints is not optional."
);

// 9. Risks
h1("9. Risks & Known Issues");

h2("Active Risks");
table(
  ["Risk", "Likelihood", "Mitigation"],
  [
    ["Production engines write directly to runtime_domains (bypassing RDM)", "Low — Sprint 2", "Adapters wrap all writes in Sprint 2"],
    ["history table grows unbounded over months", "Low (long-term)", "90-day GC policy; Sprint 5 ValidationManager"],
    ["Pool connection leak in long-running instance", "Low", "All connections released in finally; monitored via getStats()"],
  ],
  [240, 80, 192]
);

h2("Known Issues");
table(
  ["ID", "Description", "Plan"],
  [
    ["KI-1", "server.js, shadowm.js, shadowlab.js still write directly to runtime_domains", "Sprint 2 adapters"],
    ["KI-2", "Pre-Sprint-1 snapshots cannot be restored via restoreFromSnapshot()", "Documented; listed in listSnapshots()"],
    ["KI-3", "History GC not yet implemented (90-day policy)", "Sprint 5 ValidationManager"],
  ],
  [40, 300, 172]
);

// 10. Final Gate
h1("10. Final Gate Checklist");
table(
  ["Gate", "Status"],
  [
    ["✓ RuntimeDomainManager is production ready", "✅ PASS"],
    ["✓ 107 tests pass, 0 fail", "✅ PASS"],
    ["✓ 19 Sprint 0 regression tests pass", "✅ PASS"],
    ["✓ MASTER_ARCHITECTURE.md complete", "✅ PASS"],
    ["✓ Documentation complete", "✅ PASS"],
    ["✓ No production behavior changed", "✅ PASS"],
    ["✓ Sacred Constraint honored", "✅ PASS"],
    ["✓ Checkpoint created", "⏳ Pending"],
    ["✓ Git committed (user pushes from Shell)", "⏳ Pending"],
  ],
  [320, 192]
);

vSpace(10);
checkY(60);
doc.save()
   .rect(MARGIN, y, CONTENT_W, 52)
   .fill(C.greenBg)
   .restore();
doc.save()
   .rect(MARGIN, y, CONTENT_W, 52)
   .lineWidth(1).strokeColor(C.green).stroke()
   .restore();
doc.font(F.bold).fontSize(14).fillColor(C.green)
   .text("SPRINT 1 STATUS: ✅ COMPLETE", MARGIN, y + 8, { width: CONTENT_W, align: "center" });
doc.font(F.regular).fontSize(9).fillColor(C.darkGray)
   .text(
     "STOP — Do NOT begin Sprint 2. Wait for Project Review and Product Owner approval.",
     MARGIN, y + 30, { width: CONTENT_W, align: "center" }
   );
y += 60;

// Footer
vSpace(20);
checkY(20);
doc.font(F.regular).fontSize(8).fillColor(C.lightGray)
   .text(
     `FOREX ENGINE PRO  |  Sprint 1 Report  |  2026-07-06  |  107 tests, 0 failures  |  Chief Architect: Replit Agent`,
     MARGIN, PAGE_H - MARGIN - 20, { width: CONTENT_W, align: "center" }
   );

doc.end();
console.log(`[PDF] Generated: ${OUTPUT}`);
