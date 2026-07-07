"use strict";
/**
 * Generates docs/architecture/MASTER_ARCHITECTURE.pdf from MASTER_ARCHITECTURE.md
 * Run: node docs/architecture/generate_architecture_pdf.js
 */

const PDFDocument = require("pdfkit");
const fs          = require("fs");
const path        = require("path");

const INPUT  = path.join(__dirname, "MASTER_ARCHITECTURE.md");
const OUTPUT = path.join(__dirname, "MASTER_ARCHITECTURE.pdf");

const C = {
  black:     "#1a1a1a",
  darkGray:  "#2d2d2d",
  midGray:   "#555555",
  lightGray: "#888888",
  border:    "#cccccc",
  bg:        "#f5f5f5",
  green:     "#1a7340",
  greenBg:   "#e8f5ee",
  accent:    "#2c5f8a",
  white:     "#ffffff",
  tableHead: "#2c5f8a",
  tableRow:  "#f9f9f9",
  tableAlt:  "#ffffff",
  gold:      "#b8860b",
  goldBg:    "#fffaed",
};

const F = {
  regular: "Helvetica",
  bold:    "Helvetica-Bold",
  italic:  "Helvetica-Oblique",
  mono:    "Courier",
};

const PAGE_W    = 612;
const PAGE_H    = 792;
const MARGIN    = 50;
const CONTENT_W = PAGE_W - MARGIN * 2;

const doc = new PDFDocument({
  size:    "LETTER",
  margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
  info: {
    Title:   "MASTER ARCHITECTURE — SHADOW OS v2",
    Author:  "FOREX ENGINE PRO",
    Subject: "SHADOW OS v2 — Single Source of Truth Architecture Document",
    Creator: "generate_architecture_pdf.js (pdfkit)",
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
     .text("FOREX ENGINE PRO  |  SHADOW OS v2  |  MASTER ARCHITECTURE", MARGIN, 11);
  doc.font(F.regular).fontSize(8).fillColor(C.white)
     .text(`Page ${pageNum}`, PAGE_W - MARGIN - 40, 11, { width: 40, align: "right" });
  y = 48;
}

function checkY(needed) {
  if (y + needed > PAGE_H - MARGIN - 20) newPage();
}

function hRule(color = C.border, thick = 0.5) {
  doc.save().moveTo(MARGIN, y).lineTo(PAGE_W - MARGIN, y)
     .lineWidth(thick).strokeColor(color).stroke().restore();
  y += 5;
}

function vSpace(n = 8) { y += n; }

function h1(text) {
  checkY(60);
  vSpace(14);
  doc.save().rect(MARGIN, y, 4, 22).fill(C.accent).restore();
  doc.font(F.bold).fontSize(14).fillColor(C.accent)
     .text(text, MARGIN + 12, y, { width: CONTENT_W - 12 });
  y += 26;
  hRule(C.accent, 1);
}

function h2(text) {
  checkY(36);
  vSpace(10);
  doc.font(F.bold).fontSize(11).fillColor(C.darkGray)
     .text(text, MARGIN, y, { width: CONTENT_W });
  y += 14;
  hRule(C.border);
}

function h3(text) {
  checkY(24);
  vSpace(6);
  doc.font(F.bold).fontSize(9.5).fillColor(C.accent)
     .text(text, MARGIN, y, { width: CONTENT_W });
  y += 13;
}

function para(text, opts = {}) {
  const fontSize = opts.fontSize || 8.5;
  const color    = opts.color    || C.black;
  const indent   = opts.indent   || 0;
  const font     = opts.font     || F.regular;
  doc.font(font).fontSize(fontSize).fillColor(color);
  const h = doc.heightOfString(text, { width: CONTENT_W - indent });
  checkY(h + 3);
  doc.text(text, MARGIN + indent, y, { width: CONTENT_W - indent });
  y += h + 3;
}

function codeBlock(text) {
  const lines  = text.split("\n");
  const lineH  = 10;
  const pad    = 7;
  const totalH = lines.length * lineH + pad * 2;
  checkY(totalH + 6);
  doc.save().rect(MARGIN, y, CONTENT_W, totalH).fill(C.bg).restore();
  doc.save().rect(MARGIN, y, CONTENT_W, totalH).lineWidth(0.5).strokeColor(C.border).stroke().restore();
  doc.save().rect(MARGIN, y, 3, totalH).fill(C.accent).restore();
  let cy = y + pad;
  for (const line of lines) {
    doc.font(F.mono).fontSize(6.8).fillColor(C.darkGray)
       .text(line, MARGIN + 9, cy, { width: CONTENT_W - 13, lineBreak: false });
    cy += lineH;
  }
  y = y + totalH + 5;
}

function table(headers, rows, colWidths) {
  const headH  = 18;
  const rowH   = 16;
  const pad    = 4;
  const totalW = colWidths.reduce((a, b) => a + b, 0);
  checkY(headH + rowH + 8);
  doc.save().rect(MARGIN, y, totalW, headH).fill(C.tableHead).restore();
  let cx = MARGIN;
  for (let i = 0; i < headers.length; i++) {
    doc.font(F.bold).fontSize(7.5).fillColor(C.white)
       .text(headers[i], cx + pad, y + 5, { width: colWidths[i] - pad * 2, lineBreak: false });
    cx += colWidths[i];
  }
  y += headH;
  for (let r = 0; r < rows.length; r++) {
    const row  = rows[r];
    const bg   = r % 2 === 0 ? C.tableRow : C.tableAlt;
    let maxH   = rowH;
    cx = MARGIN;
    for (let c = 0; c < row.length; c++) {
      const cellH = doc.font(F.regular).fontSize(7.5)
                       .heightOfString(String(row[c] || ""), { width: colWidths[c] - pad * 2 });
      if (cellH + 6 > maxH) maxH = cellH + 6;
      cx += colWidths[c];
    }
    checkY(maxH + 2);
    doc.save().rect(MARGIN, y, totalW, maxH).fill(bg).restore();
    cx = MARGIN;
    for (let c = 0; c < row.length; c++) {
      const cellText = String(row[c] || "");
      let cellColor  = C.black;
      if (cellText.includes("✅") || cellText.includes("DONE") || cellText.includes("COMPLETE")) cellColor = C.green;
      if (cellText.includes("PLANNED") || cellText.includes("Sprint")) cellColor = C.midGray;
      doc.font(F.regular).fontSize(7.5).fillColor(cellColor)
         .text(cellText, cx + pad, y + 4, { width: colWidths[c] - pad * 2, lineBreak: true });
      cx += colWidths[c];
    }
    doc.save().moveTo(MARGIN, y + maxH).lineTo(MARGIN + totalW, y + maxH)
       .lineWidth(0.3).strokeColor(C.border).stroke().restore();
    y += maxH;
  }
  y += 8;
}

// ── COVER PAGE ─────────────────────────────────────────────────────────────
doc.addPage();
pageNum++;

doc.save().rect(0, 0, PAGE_W, 240).fill(C.accent).restore();
doc.save().rect(0, 240, PAGE_W, 8).fill(C.gold).restore();

doc.font(F.bold).fontSize(26).fillColor(C.white)
   .text("MASTER ARCHITECTURE", MARGIN, 55, { width: CONTENT_W, align: "center" });
doc.font(F.bold).fontSize(16).fillColor("#aacce8")
   .text("SHADOW OS v2", MARGIN, 92, { width: CONTENT_W, align: "center" });
doc.font(F.regular).fontSize(10).fillColor("#d0e4f0")
   .text("FOREX ENGINE PRO — Autonomous Trading Operating System", MARGIN, 116, { width: CONTENT_W, align: "center" });

doc.save().roundedRect(PAGE_W / 2 - 100, 148, 200, 30, 4).fill(C.gold).restore();
doc.font(F.bold).fontSize(11).fillColor(C.white)
   .text("SINGLE SOURCE OF TRUTH", PAGE_W / 2 - 100, 157, { width: 200, align: "center" });

doc.save().roundedRect(PAGE_W / 2 - 70, 190, 140, 22, 4).fill("#27ae60").restore();
doc.font(F.bold).fontSize(9).fillColor(C.white)
   .text("Version 1.0  ·  Sprint 1  ·  2026-07-06", PAGE_W / 2 - 70, 196, { width: 140, align: "center" });

doc.save().rect(MARGIN, 258, CONTENT_W, 120).fill(C.bg).restore();
doc.save().rect(MARGIN, 258, CONTENT_W, 120).lineWidth(0.5).strokeColor(C.border).stroke().restore();

const metaItems = [
  ["Classification", "Principal Architecture Document"],
  ["Version",        "1.0 — Active, enforced"],
  ["Baseline",       "SHADOW OS v1 / Architecture B"],
  ["Scope",          "5-year operational horizon, 100k+ trades, 10+ engines"],
  ["Authors",        "Sprint 0 (Foundation) + Sprint 1 (Runtime Awakening)"],
  ["Next Review",    "Sprint 2 (Domain Wiring)"],
  ["Status",         "Sprint 1 implemented · Sprints 2–5 specified"],
];

let my = 266;
for (const [k, v] of metaItems) {
  doc.font(F.bold).fontSize(8).fillColor(C.midGray)
     .text(k + ":", MARGIN + 12, my, { width: 100, lineBreak: false });
  doc.font(F.regular).fontSize(8).fillColor(C.darkGray)
     .text(v, MARGIN + 116, my, { width: CONTENT_W - 128, lineBreak: false });
  my += 16;
}

const items = [
  ["14",  "Components\nMapped"],
  ["10",  "Runtime\nDomains"],
  ["5",   "Managers\nDefined"],
  ["11",  "DB Tables\nSchemas"],
  ["15",  "Sections\nCovered"],
];

let ix   = MARGIN;
const iW  = CONTENT_W / items.length;
const iY  = 402;
doc.save().rect(MARGIN, iY, CONTENT_W, 76).fill("#e8f0fa").restore();
doc.save().rect(MARGIN, iY, CONTENT_W, 76).lineWidth(0.5).strokeColor(C.border).stroke().restore();
for (const [num, lbl] of items) {
  doc.font(F.bold).fontSize(20).fillColor(C.accent).text(num, ix, iY + 12, { width: iW, align: "center" });
  doc.font(F.regular).fontSize(7).fillColor(C.midGray).text(lbl, ix, iY + 40, { width: iW, align: "center" });
  ix += iW;
}

doc.font(F.regular).fontSize(7.5).fillColor(C.lightGray)
   .text(
     "FOREX ENGINE PRO  |  MASTER ARCHITECTURE — SHADOW OS v2  |  Single Source of Truth",
     MARGIN, PAGE_H - MARGIN - 18, { width: CONTENT_W, align: "center" }
   );

// ── CONTENT ────────────────────────────────────────────────────────────────
newPage();

// Sacred Constraint
checkY(44);
doc.save().rect(MARGIN, y, CONTENT_W, 38).fill(C.goldBg).restore();
doc.save().rect(MARGIN, y, CONTENT_W, 38).lineWidth(1).strokeColor(C.gold).stroke().restore();
doc.save().rect(MARGIN, y, 4, 38).fill(C.gold).restore();
doc.font(F.bold).fontSize(9).fillColor(C.gold)
   .text("SACRED CONSTRAINT — NEVER VIOLATED", MARGIN + 12, y + 6);
doc.font(F.italic).fontSize(9).fillColor(C.darkGray)
   .text(
     "No deployment, restart, or migration step may ever destroy the accumulated trading knowledge of the system.",
     MARGIN + 12, y + 20, { width: CONTENT_W - 18 }
   );
y += 46;

// Section 1
h1("1. Purpose and Scope");
para(
  "This document is the single source of truth for SHADOW OS v2. Every implementation decision, API " +
  "design, and database schema must be consistent with what is written here. When this document and " +
  "the code disagree, this document wins — update the code."
);

h2("Design Horizon");
para("5 years of continuous operation  ·  100,000+ closed trades  ·  10+ concurrent engines  ·  Sub-second latency under any failure condition");

// Section 2 — 6 Invariants
h1("2. Core Design Philosophy — Six Invariants");

const invariants = [
  ["INVARIANT 1: Single Source of Truth",
   "For every piece of information, exactly one layer owns it. Runtime Layer owns operational state. Memory Layer owns contextual memory. Knowledge Layer owns learned intelligence. Event Log owns historical record."],
  ["INVARIANT 2: Manager Mediation",
   "No engine module reads from or writes to PostgreSQL directly. All DB access goes through the Manager Tier. Sprint 1 introduces RuntimeDomainManager; existing production files access DB directly until their manager is ready."],
  ["INVARIANT 3: Knowledge Immutability",
   "Knowledge artifacts are never deleted; they are superseded. Every training run produces a new version. The lineage of how the system learned is always traceable."],
  ["INVARIANT 4: Memory Expiry",
   "Memory entries have a defined lifecycle and expire naturally. The system does not rely on memory entries being present. Missing memory → safe default behavior, not a crash."],
  ["INVARIANT 5: Recovery Completeness",
   "After any failure, the Recovery Manager runs all 9 phases before trading resumes. System status is HALTED until RecoveryManager reports READY or DEGRADED."],
  ["INVARIANT 6: Financial Intent Atomicity",
   "Every trade_open or trade_close is preceded by a committed trade_intent. No OANDA call is made without a committed PENDING intent. Violation → ghost trades."],
];

for (const [title, desc] of invariants) {
  checkY(36);
  doc.font(F.bold).fontSize(8.5).fillColor(C.accent)
     .text(title, MARGIN, y, { width: CONTENT_W });
  y += 12;
  para(desc, { indent: 8, color: C.darkGray });
  vSpace(4);
}

// Section 3 — Memory Hierarchy
h1("3. Four-Layer Memory Hierarchy");
codeBlock(
`RUNTIME LAYER      Fast · Versioned · Domain-partitioned · Optimistic locking
  Write: ~5ms  Read: ~2ms  Durability: survives restart
  Domains: live, shadowA, shadowB, shadowC, shadowD, shadowM, exitLab, telemetry, scheduler, meta
  Owner: RuntimeDomainManager (Sprint 1)  ←  IMPLEMENTED

MEMORY LAYER       TTL-based · Contextual · Self-expiring · GC-managed
  Write: ~5ms  Read: ~3ms  Durability: TTL (hours to days)
  Namespaces: observations, cooldowns, market_state, volatility, correlations, decision_history
  Owner: MemoryManager (Sprint 3)  ←  PLANNED

KNOWLEDGE LAYER    Permanent · Versioned · Append-only · Checksum-verified
  Write: ~20ms  Read: ~10ms  Durability: forever (never deleted, only superseded)
  Artifacts: engineC/*, engineD/*, exitLab/*, market/*, system/*
  Owner: KnowledgeManager (Sprint 4)  ←  PLANNED

EVENT LOG          Immutable · Append-only · Audit-only
  Write: ~5ms  Durability: forever
  Purpose: compliance, analytics, replay — NOT recovery
  Owner: existing telemetry/index.js (unchanged)  ←  FROZEN`
);

// Section 4 — Component Map
h1("4. Component Map & Responsibilities");
table(
  ["Component", "File", "Domain", "Status"],
  [
    ["Live Bot",              "index.js",       "—",            "FROZEN"],
    ["Server / Orchestrator", "server.js",      "live, sched., meta", "FROZEN"],
    ["Shadow A/B/C/D",        "shadowlab.js",   "shadowA–D, exitLab", "FROZEN"],
    ["Shadow M",              "shadowm.js",     "shadowM",      "FROZEN"],
    ["Telemetry",             "index.js",       "telemetry",    "FROZEN"],
    ["RuntimeDomainManager",  "managers/RDM.js","ALL (10)",     "✅ Sprint 1"],
    ["MemoryManager",         "managers/MM.js", "memory_entries","Sprint 3"],
    ["KnowledgeManager",      "managers/KM.js", "knowledge_artifacts","Sprint 4"],
    ["RecoveryManager",       "managers/Rec.js","consistency_log","Sprint 5"],
    ["ValidationManager",     "managers/Val.js","consistency_log","Sprint 5"],
  ],
  [160, 120, 100, 132]
);

// Section 5 — Domains
h1("5. Runtime Domains (10 Domains)");
table(
  ["Domain", "Owner (current)", "Owner (v2)", "Write Freq."],
  [
    ["live",      "server.js (direct)", "LiveDomainAdapter (S2)", "High — each trade"],
    ["shadowA",   "shadowlab.js", "ShadowLabAdapter (S2)", "Each cycle ~30s"],
    ["shadowB",   "shadowlab.js", "ShadowLabAdapter (S2)", "Each cycle ~30s"],
    ["shadowC",   "shadowlab.js", "ShadowLabAdapter (S2)", "After training"],
    ["shadowD",   "shadowlab.js", "ShadowLabAdapter (S2)", "Per 100 trades"],
    ["shadowM",   "shadowm.js",   "ShadowMAdapter (S2)",   "Each poll"],
    ["exitLab",   "shadowlab.js", "ShadowLabAdapter (S2)", "Each cycle"],
    ["telemetry", "telemetry/index.js", "TelemetryAdapter (S2)", "Each batch ~30s"],
    ["scheduler", "server.js",    "SchedulerAdapter (S2)", "Each cycle boundary"],
    ["meta",      "server.js",    "MetaAdapter (S2)",      "Boot/shutdown/status"],
  ],
  [80, 130, 140, 162]
);

// Section 6 — Manager Hierarchy
h1("6. Manager Hierarchy");
table(
  ["Manager", "Sprint", "Key Methods", "Tables"],
  [
    ["RuntimeDomainManager", "1 ✅", "createDomain, getDomain, compareAndSwap, takeSnapshot, rollback", "runtime_domains, runtime_domain_history, system_snapshots, consistency_log"],
    ["MemoryManager",        "3 ⏳", "set, get, delete, gc, listNamespace", "memory_entries"],
    ["KnowledgeManager",     "4 ⏳", "saveArtifact, loadArtifact, rollback, getHistory", "knowledge_artifacts"],
    ["RecoveryManager",      "5 ⏳", "runRecovery, assessDamage, repairDomain", "consistency_log, ALL"],
    ["ValidationManager",    "5 ⏳", "runCheck, autoRepair, schedule", "consistency_log"],
  ],
  [120, 50, 190, 152]
);

// Section 7 — Startup
h1("7. Startup Sequence (Current)");
codeBlock(
`node telemetry/server.js
  1. require('./index')      → db-adapter initialized
  2. require('./shadowlab')  → engines loaded
  3. require('./shadowm')    → Shadow M loaded
  4. restoreLiveState()      → reads events for open positions [FUTURE: RDM.getDomain('live')]
  5. Express API starts on PORT
  6. spawn('node', ['index.js']) → bot starts
  7. shadowM.start()         → polling loop [FUTURE: RDM manages shadowM domain]
  8. shadowLab cycle every 30s [FUTURE: RDM manages shadowA-D, exitLab domains]
  → SYSTEM OPERATIONAL

SHADOW OS v2 Full Startup (Sprint 5+):
  1. RecoveryManager.runRecovery() — 9 phases
  2. RuntimeDomainManager.init()   — validate tables
  3. RDM.getDomain('meta').bootCount++
  4. RDM.updateDomain('meta', { status: 'HEALTHY' })
  5. RDM.takeSnapshot('boot')
  → SYSTEM OPERATIONAL`
);

// Section 8 — Recovery
h1("8. Recovery Sequences");

h2("9-Phase Recovery (Sprint 5+)");
table(
  ["Phase", "Check", "On Failure"],
  [
    ["1", "DB Connectivity — pool.query('SELECT 1') with 10s timeout", "HALT, retry 5×"],
    ["2", "Schema Integrity — all 11 tables present", "HALT if runtime tables missing"],
    ["3", "Domain Integrity — all 10 domains, valid JSON", "Repair with DEFAULT_DOMAINS"],
    ["4", "Event Cursor — shadowM.lastId vs events MAX(id)", "Log WARN, use events as truth"],
    ["5", "Position Reconciliation — live.openTrades vs events", "Use events-derived value"],
    ["6", "Knowledge Integrity — checksum verification", "Rollback artifact, log CRITICAL"],
    ["7", "Memory GC — delete expired memory_entries", "Non-fatal"],
    ["8", "Baseline Snapshot — takeSnapshot('post_recovery')", "Log WARN if fails"],
    ["9", "Status Update — meta.status = HEALTHY or DEGRADED", "Required final step"],
  ],
  [40, 290, 182]
);

// Section 9 — DB Schema
h1("9. Database Schema Summary");
table(
  ["Table", "Sprint", "PK", "Purpose"],
  [
    ["events",                  "Pre-v2",  "BIGSERIAL", "Trade event log (immutable)"],
    ["shadowm_trades",          "Pre-v2",  "BIGSERIAL", "Shadow M trade tracking"],
    ["shadowm_timeline",        "Pre-v2",  "BIGSERIAL", "Shadow M pips timeline"],
    ["runtime_domains",         "0 ✅",    "TEXT domain","Versioned domain state (10 rows)"],
    ["trade_intents",           "0 ✅",    "BIGSERIAL", "OANDA order idempotency"],
    ["memory_entries",          "0 ✅",    "BIGSERIAL", "TTL-based contextual memory"],
    ["knowledge_artifacts",     "0 ✅",    "BIGSERIAL", "Versioned learned intelligence"],
    ["event_idempotency",       "0 ✅",    "TEXT key",  "Event deduplication"],
    ["consistency_log",         "0 ✅",    "BIGSERIAL", "Self-healing audit trail"],
    ["system_snapshots",        "0 ✅",    "BIGSERIAL", "Full state captures"],
    ["runtime_domain_history",  "1 ✅",    "BIGSERIAL", "Per-domain mutation history"],
  ],
  [150, 55, 85, 222]
);

// Section 10 — Implementation Status
h1("10. Implementation Status");
table(
  ["Component", "Sprint", "Status", "Tests"],
  [
    ["DB Schema (10 tables)",        "0", "✅ COMPLETE", "19 pass"],
    ["Dead code archive",            "0", "✅ COMPLETE", "—"],
    ["Test framework",               "0", "✅ COMPLETE", "Operational"],
    ["runtime_domain_history table", "1", "✅ COMPLETE", "—"],
    ["RuntimeDomainManager",         "1", "✅ COMPLETE", "107 pass"],
    ["TradeIntentManager",           "2", "⏳ PLANNED",  "—"],
    ["Domain Adapters",              "2", "⏳ PLANNED",  "—"],
    ["MemoryManager",                "3", "⏳ PLANNED",  "—"],
    ["KnowledgeManager",             "4", "⏳ PLANNED",  "—"],
    ["RecoveryManager",              "5", "⏳ PLANNED",  "—"],
    ["ValidationManager",            "5", "⏳ PLANNED",  "—"],
  ],
  [200, 50, 100, 162]
);

// Sprint Roadmap
h1("11. Sprint Roadmap");
table(
  ["Sprint", "Name", "Core Deliverable", "Key Risk"],
  [
    ["0 ✅", "Foundation",       "DB schema, test framework, dead code archive", "Idempotent migration"],
    ["1 ✅", "Runtime Awakening","RuntimeDomainManager — complete domain ownership", "CAS pool deadlock (fixed)"],
    ["2 ⏳", "Domain Wiring",    "Adapters — connect existing engines to RDM", "Behavior regression"],
    ["3 ⏳", "Memory OS",        "MemoryManager — TTL-based contextual memory", "GC correctness"],
    ["4 ⏳", "Knowledge OS",     "KnowledgeManager — learned intelligence persistence", "Checksum integrity"],
    ["5 ⏳", "Recovery OS",      "RecoveryManager + ValidationManager", "Complex state repair"],
    ["6 ⏳", "Intelligence",     "Incremental training, startup < 50ms at scale", "Artifact size growth"],
  ],
  [52, 110, 210, 140]
);

doc.end();
console.log(`[PDF] Generated: ${OUTPUT}`);
