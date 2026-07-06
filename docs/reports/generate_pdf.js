"use strict";
/**
 * Generates docs/reports/SPRINT_0_REPORT.pdf from SPRINT_0_REPORT.md
 * Uses pdfkit — zero external binary dependencies.
 * Run: node docs/reports/generate_pdf.js
 */

const PDFDocument = require("pdfkit");
const fs          = require("fs");
const path        = require("path");

const INPUT  = path.join(__dirname, "SPRINT_0_REPORT.md");
const OUTPUT = path.join(__dirname, "SPRINT_0_REPORT.pdf");

const md = fs.readFileSync(INPUT, "utf8");

// ── Colour palette ────────────────────────────────────────────────────────
const C = {
  black:      "#1a1a1a",
  darkGray:   "#2d2d2d",
  midGray:    "#555555",
  lightGray:  "#888888",
  border:     "#cccccc",
  bg:         "#f5f5f5",
  green:      "#1a7340",
  greenBg:    "#e8f5ee",
  red:        "#c0392b",
  blue:       "#1a4a7a",
  blueBg:     "#e8f0fa",
  accent:     "#2c5f8a",
  white:      "#ffffff",
  tableHead:  "#2c5f8a",
  tableRow:   "#f9f9f9",
  tableAlt:   "#ffffff",
};

// ── Fonts (pdfkit built-ins) ──────────────────────────────────────────────
const F = {
  regular:   "Helvetica",
  bold:      "Helvetica-Bold",
  italic:    "Helvetica-Oblique",
  mono:      "Courier",
  monoBold:  "Courier-Bold",
};

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 50;
const CONTENT_W = PAGE_W - MARGIN * 2;

const doc = new PDFDocument({
  size:        "LETTER",
  margins:     { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
  info: {
    Title:    "Sprint 0 Report — SHADOW OS v2 Foundation",
    Author:   "FOREX ENGINE PRO — Automated Report",
    Subject:  "SHADOW OS v2 Migration Sprint 0",
    Keywords: "sprint,migration,postgresql,shadow-os,forex",
    Creator:  "generate_pdf.js (pdfkit)",
  },
  autoFirstPage: false,
});

doc.pipe(fs.createWriteStream(OUTPUT));

// ── State ─────────────────────────────────────────────────────────────────
let pageNum = 0;
let y       = MARGIN;

// ── Page management ───────────────────────────────────────────────────────
function newPage() {
  doc.addPage();
  pageNum++;
  y = MARGIN;

  // Header bar
  doc.save()
     .rect(0, 0, PAGE_W, 32)
     .fill(C.accent)
     .restore();
  doc.font(F.bold).fontSize(8).fillColor(C.white)
     .text("FOREX ENGINE PRO  |  SHADOW OS v2 Migration  |  Sprint 0 Report", MARGIN, 11);
  doc.font(F.regular).fontSize(8).fillColor(C.white)
     .text(`Page ${pageNum}`, PAGE_W - MARGIN - 50, 11, { width: 50, align: "right" });

  y = 48;
}

function checkY(needed) {
  if (y + needed > PAGE_H - MARGIN - 20) {
    newPage();
  }
}

// ── Drawing helpers ───────────────────────────────────────────────────────
function hRule(color = C.border, thick = 0.5) {
  doc.save().moveTo(MARGIN, y).lineTo(PAGE_W - MARGIN, y)
     .lineWidth(thick).strokeColor(color).stroke().restore();
  y += 6;
}

function vSpace(n = 8) { y += n; }

function h1(text) {
  checkY(60);
  vSpace(14);

  // Accent bar left of heading
  doc.save()
     .rect(MARGIN, y, 4, 22)
     .fill(C.accent)
     .restore();

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
  const bullet_char = level === 0 ? "•" : "–";
  const fontSize = 9;

  doc.font(F.regular).fontSize(fontSize).fillColor(C.midGray);
  const bW = doc.widthOfString(bullet_char + " ");
  const textW = CONTENT_W - indent - bW;
  const h = doc.heightOfString(text, { width: textW });
  checkY(h + 3);

  doc.text(bullet_char, MARGIN + indent, y);
  doc.font(F.regular).fontSize(fontSize).fillColor(C.black)
     .text(text, MARGIN + indent + bW, y, { width: textW });
  y += h + 3;
}

function codeBlock(text) {
  const lines   = text.split("\n");
  const lineH   = 11;
  const padding = 8;
  const totalH  = lines.length * lineH + padding * 2;

  checkY(totalH + 8);

  doc.save()
     .rect(MARGIN, y, CONTENT_W, totalH)
     .fill(C.bg)
     .restore();
  doc.save()
     .rect(MARGIN, y, CONTENT_W, totalH)
     .lineWidth(0.5).strokeColor(C.border).stroke()
     .restore();
  doc.save()
     .rect(MARGIN, y, 3, totalH)
     .fill(C.accent)
     .restore();

  let cy = y + padding;
  for (const line of lines) {
    doc.font(F.mono).fontSize(7.5).fillColor(C.darkGray)
       .text(line, MARGIN + 10, cy, { width: CONTENT_W - 14, lineBreak: false });
    cy += lineH;
  }
  y = y + totalH + 6;
}

function statusBadge(text, pass) {
  const color = pass ? C.green : C.red;
  const bg    = pass ? C.greenBg : "#fde8e8";
  const w     = 80;
  const h     = 16;

  checkY(h + 4);
  doc.save().rect(MARGIN, y, w, h).fill(bg).restore();
  doc.save().rect(MARGIN, y, w, h).lineWidth(0.5).strokeColor(color).stroke().restore();
  doc.font(F.bold).fontSize(8).fillColor(color)
     .text(text, MARGIN, y + 4, { width: w, align: "center" });
  y += h + 6;
}

// ── Table renderer ────────────────────────────────────────────────────────
function table(headers, rows, colWidths) {
  const rowH    = 18;
  const headH   = 20;
  const padding = 5;
  const totalW  = colWidths.reduce((a, b) => a + b, 0);

  // Header
  checkY(headH + rowH + 10);

  // Header background
  doc.save()
     .rect(MARGIN, y, totalW, headH)
     .fill(C.tableHead)
     .restore();

  let cx = MARGIN;
  for (let i = 0; i < headers.length; i++) {
    doc.font(F.bold).fontSize(8).fillColor(C.white)
       .text(headers[i], cx + padding, y + 6, { width: colWidths[i] - padding * 2, lineBreak: false });
    cx += colWidths[i];
  }
  y += headH;

  // Rows
  for (let r = 0; r < rows.length; r++) {
    const row    = rows[r];
    const bgFill = r % 2 === 0 ? C.tableRow : C.tableAlt;

    // Calculate row height
    let maxH = rowH;
    cx = MARGIN;
    for (let c = 0; c < row.length; c++) {
      const cellText = String(row[c] || "");
      const cellH = doc.font(F.regular).fontSize(8)
                       .heightOfString(cellText, { width: colWidths[c] - padding * 2 });
      if (cellH + 8 > maxH) maxH = cellH + 8;
      cx += colWidths[c];
    }

    checkY(maxH + 2);

    doc.save()
       .rect(MARGIN, y, totalW, maxH)
       .fill(bgFill)
       .restore();

    cx = MARGIN;
    for (let c = 0; c < row.length; c++) {
      const cellText = String(row[c] || "");
      // Detect status markers
      let cellColor = C.black;
      if (cellText.includes("✅") || cellText.includes("PASS")) cellColor = C.green;
      if (cellText.includes("✗") || cellText.includes("FAIL") || cellText.includes("MISSING")) cellColor = C.red;

      doc.font(F.regular).fontSize(8).fillColor(cellColor)
         .text(cellText, cx + padding, y + 5, {
           width:    colWidths[c] - padding * 2,
           lineBreak: true,
         });
      cx += colWidths[c];
    }

    // Bottom border
    doc.save()
       .moveTo(MARGIN, y + maxH)
       .lineTo(MARGIN + totalW, y + maxH)
       .lineWidth(0.3).strokeColor(C.border).stroke()
       .restore();

    y += maxH;
  }

  // Outer border
  doc.save()
     .rect(MARGIN, y - (rows.length * rowH + headH), totalW,
           rows.length * rowH + headH)
     .lineWidth(0.5).strokeColor(C.border).stroke()
     .restore();

  y += 10;
}

// ─────────────────────────────────────────────────────────────────────────
// COVER PAGE
// ─────────────────────────────────────────────────────────────────────────
doc.addPage();
pageNum++;

// Background gradient-like top bar
doc.save().rect(0, 0, PAGE_W, 220).fill(C.accent).restore();
doc.save().rect(0, 220, PAGE_W, 8).fill(C.green).restore();

// Logo text
doc.font(F.bold).fontSize(28).fillColor(C.white)
   .text("FOREX ENGINE PRO", MARGIN, 60, { width: CONTENT_W, align: "center" });
doc.font(F.regular).fontSize(13).fillColor("#aacce8")
   .text("SHADOW OS v2 Migration Program", MARGIN, 98, { width: CONTENT_W, align: "center" });

// Sprint badge
doc.save()
   .roundedRect(PAGE_W / 2 - 70, 130, 140, 36, 6)
   .fill(C.green)
   .restore();
doc.font(F.bold).fontSize(16).fillColor(C.white)
   .text("SPRINT 0", PAGE_W / 2 - 70, 139, { width: 140, align: "center" });
doc.font(F.regular).fontSize(9).fillColor("#d0f0e0")
   .text("Infrastructure Foundation", PAGE_W / 2 - 70, 157, { width: 140, align: "center" });

// Status badge
doc.save()
   .roundedRect(PAGE_W / 2 - 55, 184, 110, 26, 4)
   .fill("#27ae60")
   .restore();
doc.font(F.bold).fontSize(11).fillColor(C.white)
   .text("✅  SPRINT PASSED", PAGE_W / 2 - 55, 191, { width: 110, align: "center" });

// Metadata box
doc.save()
   .rect(MARGIN, 250, CONTENT_W, 130)
   .fill(C.bg)
   .restore();
doc.save()
   .rect(MARGIN, 250, CONTENT_W, 130)
   .lineWidth(0.5).strokeColor(C.border).stroke()
   .restore();

const meta = [
  ["Date",         "2026-07-06"],
  ["Version",      "1.0"],
  ["Git Commit",   "dc2a2791e97fb074b7df10c7ba51ae3a7d2fbdf9"],
  ["Database",     "heliumdb — PostgreSQL 16.10 (Railway)"],
  ["Test Results", "19/19 PASS (8 smoke + 11 schema)"],
  ["Gates",        "7/7 PASSED"],
  ["Data Lost",    "0 rows"],
];

let my = 260;
for (const [k, v] of meta) {
  doc.font(F.bold).fontSize(9).fillColor(C.midGray)
     .text(k + ":", MARGIN + 16, my, { width: 90, lineBreak: false });
  doc.font(F.mono).fontSize(9).fillColor(C.darkGray)
     .text(v, MARGIN + 110, my, { width: CONTENT_W - 126, lineBreak: false });
  my += 16;
}

// Summary metrics row
const metrics = [
  ["7", "Gates\nPassed"],
  ["19", "Tests\nPassed"],
  ["10", "DB Tables\nCreated"],
  ["8", "Files\nArchived"],
  ["0", "Data\nLost"],
];

let mx = MARGIN;
const mBoxW = CONTENT_W / metrics.length;
const mY = 406;

doc.save().rect(MARGIN, mY, CONTENT_W, 80).fill(C.blueBg).restore();
doc.save().rect(MARGIN, mY, CONTENT_W, 80).lineWidth(0.5).strokeColor(C.border).stroke().restore();

for (const [num, label] of metrics) {
  doc.font(F.bold).fontSize(22).fillColor(C.accent)
     .text(num, mx, mY + 14, { width: mBoxW, align: "center" });
  doc.font(F.regular).fontSize(7.5).fillColor(C.midGray)
     .text(label, mx, mY + 42, { width: mBoxW, align: "center" });
  mx += mBoxW;
}

// Footer
doc.font(F.regular).fontSize(8).fillColor(C.lightGray)
   .text(
     "FOREX ENGINE PRO  |  Sprint 0 Report  |  SHADOW OS v2 Foundation",
     MARGIN, PAGE_H - MARGIN - 20, { width: CONTENT_W, align: "center" }
   );

// ─────────────────────────────────────────────────────────────────────────
// PAGE 2+ — CONTENT
// ─────────────────────────────────────────────────────────────────────────
newPage();

// ── 1. Executive Summary ──────────────────────────────────────────────────
h1("1. Executive Summary");
para(
  "Sprint 0 establishes the non-negotiable infrastructure required before a single line of SHADOW OS v2 " +
  "logic can be written. All six objectives were completed in a single session without any deployment, " +
  "restart, or data-loss event."
);
vSpace(4);
para(
  "The production bot (node telemetry/server.js) was not touched. All 29 rows of accumulated trading " +
  "knowledge (events) and the live shadowm_trades record were preserved intact. The heliumdb PostgreSQL " +
  "database now contains all 10 tables required by the SHADOW OS v2 architecture. A fully idempotent " +
  "migration script and a 19-test validation suite verify that the foundation is solid."
);
vSpace(6);

// Sacred constraint callout
checkY(44);
doc.save()
   .rect(MARGIN, y, CONTENT_W, 36)
   .fill(C.greenBg)
   .restore();
doc.save()
   .rect(MARGIN, y, 4, 36)
   .fill(C.green)
   .restore();
doc.font(F.bold).fontSize(8).fillColor(C.green)
   .text("Sacred Constraint (upheld throughout)", MARGIN + 12, y + 6);
doc.font(F.italic).fontSize(8.5).fillColor(C.darkGray)
   .text(
     "No deployment, restart, or migration step may ever destroy the accumulated trading knowledge of the system.",
     MARGIN + 12, y + 18, { width: CONTENT_W - 20 }
   );
y += 44;

// ── 2. Objectives ─────────────────────────────────────────────────────────
h1("2. Objectives");
table(
  ["#", "Objective", "Result"],
  [
    ["1", "Archive all dead code with zero active dependencies broken", "✅ COMPLETE"],
    ["2", "Create test framework using Node 24 built-in node:test", "✅ COMPLETE"],
    ["3", "Write idempotent schema migration SQL for all 7 new tables", "✅ COMPLETE"],
    ["4", "Build and validate the migration runner", "✅ COMPLETE"],
    ["5", "Apply migration to production database with zero data loss", "✅ COMPLETE"],
    ["6", "Produce Sprint 0 documentation", "✅ COMPLETE"],
  ],
  [30, 380, 102]
);

// ── 3. Completed Tasks ────────────────────────────────────────────────────
h1("3. Completed Tasks");

h2("Task 1 — Dead Code Archive (GATE-0.A)");
para("Identified 8 dead backup files with zero require() references in any active source file. Moved all 8 to archive/ preserving git rename-detection history.");
vSpace(4);
para("Pre-archive safety check: grep -r require() across all 5 active source files returned 0 matches.", { color: C.midGray, fontSize: 8.5 });
vSpace(4);
table(
  ["#", "Original Path", "Archive Path"],
  [
    ["1", "dashboard.js", "archive/dashboard.js"],
    ["2", "index_backup_v39_2.js", "archive/index_backup_v39_2.js"],
    ["3", "index_backup_v39_3_before_v39_4.js", "archive/index_backup_v39_3_before_v39_4.js"],
    ["4", "index_backup_v39_4_before_v39_4b.js", "archive/index_backup_v39_4_before_v39_4b.js"],
    ["5", "index_original_safe.js", "archive/index_original_safe.js"],
    ["6", "index_railway_mtf_v39_optimized.js", "archive/index_railway_mtf_v39_optimized.js"],
    ["7", "telemetry/server_backup_pre_snowball_lab.js", "archive/server_backup_pre_snowball_lab.js"],
    ["8", "telemetry/shadowlab_backup_pre_v40.js", "archive/shadowlab_backup_pre_v40.js"],
  ],
  [30, 265, 217]
);

h2("Task 2 — Test Framework (GATE-0.B)");
para("Created telemetry/tests/ with a four-tier structure using zero additional npm dependencies — Node 24's built-in node:test + node:assert/strict.");
vSpace(4);
codeBlock(`telemetry/tests/
  README.md                    # Runner instructions, conventions, phase-gate policy
  unit/
    smoke.test.js              # 8 tests — environment, db-adapter, existing tables
    schema.test.js             # 11 tests — all 10 tables, indexes, constraints, idempotency
  integration/                 # Placeholder — Sprint 1+
  stress/                      # Placeholder — Sprint 3+
  mocks/                       # Placeholder — Sprint 1+`);

h2("Task 3 — Schema Migration SQL (GATE-0.C)");
para("telemetry/migrations/001_shadow_os_v2_schema.sql (220 lines). All DDL uses CREATE TABLE IF NOT EXISTS and CREATE INDEX IF NOT EXISTS. All bootstrap inserts use ON CONFLICT DO NOTHING. Fully idempotent.");

h2("Task 4 — Migration Runner (GATE-0.D)");
para("telemetry/migrations/run.js (179 lines). Validates DATABASE_URL, captures pre-migration row counts, executes SQL via psql -f --set ON_ERROR_STOP=1, verifies all 10 tables and 10 domain rows, compares post-migration row counts against baseline.");

h2("Task 5 — Migration Applied + Idempotency (GATE-0.D + GATE-0.E)");
para("First run: created 7 new tables, 12 new indexes, 10 bootstrap rows. Second run: all IF NOT EXISTS / ON CONFLICT DO NOTHING applied, 0 errors, 0 changes.");

h2("Task 6 — Zero Active Code Modified (GATE-0.F)");
codeBlock(`git diff HEAD -- telemetry/server.js telemetry/shadowm.js telemetry/shadowlab.js
                 telemetry/db-adapter.js index.js
→ 0 lines changed`);

// ── 4. Files Changed ──────────────────────────────────────────────────────
h1("4. Files Changed");
h2("New Files");
table(
  ["File", "Purpose"],
  [
    ["archive/ (8 files)", "Dead code with preserved git history"],
    ["telemetry/migrations/001_shadow_os_v2_schema.sql", "Idempotent DDL — 220 lines"],
    ["telemetry/migrations/run.js", "Migration runner (psql-based) — 179 lines"],
    ["telemetry/tests/README.md", "Test runner documentation"],
    ["telemetry/tests/unit/smoke.test.js", "8 smoke tests"],
    ["telemetry/tests/unit/schema.test.js", "11 schema validation tests"],
    ["docs/reports/SPRINT_0_REPORT.md", "This report (Markdown)"],
    ["docs/reports/SPRINT_0_REPORT.pdf", "This report (PDF)"],
  ],
  [280, 232]
);

h2("Unchanged Active Production Files");
table(
  ["File", "Lines", "Status"],
  [
    ["index.js (FROZEN — Railway entrypoint)", "2360", "✅ 0 lines changed"],
    ["telemetry/server.js", "2997", "✅ 0 lines changed"],
    ["telemetry/shadowm.js", "718", "✅ 0 lines changed"],
    ["telemetry/shadowlab.js", "1094", "✅ 0 lines changed"],
    ["telemetry/db-adapter.js", "—", "✅ 0 lines changed"],
    ["telemetry/index.js", "—", "✅ 0 lines changed"],
  ],
  [250, 60, 202]
);

// ── 5. Database Changes ───────────────────────────────────────────────────
h1("5. Database Changes");

h2("Connection");
table(
  ["Property", "Value"],
  [
    ["Host", "heliumdb (Railway)"],
    ["Engine", "PostgreSQL 16.10 on x86_64-pc-linux-gnu"],
    ["Schema", "public"],
    ["Migration file", "001_shadow_os_v2_schema.sql"],
  ],
  [150, 362]
);

h2("New Tables Created");
table(
  ["Table", "PK", "Key Features"],
  [
    ["runtime_domains", "domain TEXT", "Versioned JSONB state; 10 bootstrap rows"],
    ["trade_intents", "BIGSERIAL id", "OANDA order idempotency; CHECK constraints"],
    ["memory_entries", "BIGSERIAL id", "Namespace K/V; UNIQUE(ns,key); GIN tags"],
    ["knowledge_artifacts", "BIGSERIAL id", "Versioned strategy snapshots; partial UNIQUE"],
    ["event_idempotency", "key TEXT", "Deduplication; FK → events"],
    ["consistency_log", "BIGSERIAL id", "Self-healing audit; CHECK on severity"],
    ["system_snapshots", "BIGSERIAL id", "Full state capture at decision points"],
  ],
  [160, 130, 222]
);

h2("Existing Tables — Data Integrity");
table(
  ["Table", "Rows Before", "Rows After", "Result"],
  [
    ["events", "29", "29", "✅ No data lost"],
    ["shadowm_trades", "1", "1", "✅ No data lost"],
    ["shadowm_timeline", "0", "0", "✅ No data lost"],
  ],
  [180, 100, 100, 132]
);

h2("runtime_domains Bootstrap Rows (10)");
table(
  ["Domain", "Purpose"],
  [
    ["live", "Daily trade counts, open positions, sequence counter"],
    ["shadowA", "Signal filter state (frozen=true initially)"],
    ["shadowB", "Signal confirmation state (frozen=true initially)"],
    ["shadowC", "KNN strategy selector state"],
    ["shadowD", "Condition weighting state"],
    ["shadowM", "Trade tracker state"],
    ["exitLab", "Exit strategy engine state"],
    ["telemetry", "Telemetry service state"],
    ["scheduler", "Cycle scheduler state"],
    ["meta", "System version, boot count, status"],
  ],
  [100, 412]
);

// ── 6. Test Results ───────────────────────────────────────────────────────
h1("6. Test Results");
h2("Smoke Tests — 8/8 PASS");
codeBlock("node --test --test-reporter=spec telemetry/tests/unit/smoke.test.js");
table(
  ["#", "Test", "Result", "ms"],
  [
    ["1", "test framework is operational", "✅ PASS", "0.8"],
    ["2", "node:assert strict mode is working", "✅ PASS", "1.3"],
    ["3", "DATABASE_URL environment variable is set", "✅ PASS", "0.1"],
    ["4", "db-adapter module loads without error", "✅ PASS", "59.4"],
    ["5", "db-adapter connects and can run a basic query", "✅ PASS", "34.3"],
    ["6", "events table exists in the database", "✅ PASS", "3.1"],
    ["7", "shadowm_trades table exists in the database", "✅ PASS", "4.1"],
    ["8", "shadowm_timeline table exists in the database", "✅ PASS", "2.4"],
  ],
  [20, 310, 100, 82]
);

h2("Schema Validation Tests — 11/11 PASS");
codeBlock("node --test --test-reporter=spec telemetry/tests/unit/schema.test.js");
table(
  ["#", "Test", "Result", "ms"],
  [
    ["1", "all 10 required tables exist", "✅ PASS", "36.0"],
    ["2", "runtime_domains has all 10 bootstrap rows", "✅ PASS", "4.1"],
    ["3", "runtime_domains columns are correct", "✅ PASS", "23.5"],
    ["4", "knowledge_artifacts has unique index on active artifacts", "✅ PASS", "7.6"],
    ["5", "trade_intents has partial index on PENDING status", "✅ PASS", "2.2"],
    ["6", "memory_entries has GIN index on tags", "✅ PASS", "2.5"],
    ["7", "consistency_log has correct severity CHECK constraint", "✅ PASS", "10.9"],
    ["8", "trade_intents has correct status CHECK constraint", "✅ PASS", "19.7"],
    ["9", "runtime_domains all rows have valid JSON values", "✅ PASS", "13.4"],
    ["10", "existing events and shadowm_trades data is intact", "✅ PASS", "4.4"],
    ["11", "migration is idempotent — running twice produces no errors", "✅ PASS", "4.0"],
  ],
  [20, 310, 100, 82]
);

h2("Overall");
table(
  ["Suite", "Pass", "Fail", "Total"],
  [
    ["smoke.test.js", "8", "0", "8"],
    ["schema.test.js", "11", "0", "11"],
    ["TOTAL", "19", "0", "19"],
  ],
  [250, 80, 80, 102]
);

// ── 7. Railway Validation ──────────────────────────────────────────────────
h1("7. Railway Validation");
table(
  ["Check", "Result"],
  [
    ["Production start command unchanged (node telemetry/server.js)", "✅ Verified"],
    ["railway.json not modified", "✅ Verified"],
    ["No new environment variables required", "✅ Verified"],
    ["No new npm packages added to production bundle", "✅ Verified"],
    ["index.js (Railway entrypoint) — 0 lines changed", "✅ Verified"],
    ["Migration runner is standalone, not part of server start", "✅ Verified"],
    ["Migration can be run: node telemetry/migrations/run.js", "✅ Verified"],
  ],
  [360, 152]
);
vSpace(4);
para(
  "No Railway deployment or restart was performed during Sprint 0. The migration runs against the " +
  "production DB directly using DATABASE_URL and is completely independent of the bot lifecycle.",
  { color: C.midGray, fontSize: 8.5 }
);

// ── 8. PostgreSQL Validation ───────────────────────────────────────────────
h1("8. PostgreSQL Validation");
table(
  ["Validation Step", "Result"],
  [
    ["Connection established", "✅"],
    ["psql available in environment (v16.10)", "✅"],
    ["All 10 expected tables in information_schema.tables", "✅"],
    ["All 10 runtime_domains rows with valid JSONB values", "✅"],
    ["All CHECK constraints enforced (severity, intent_type, status)", "✅"],
    ["All partial indexes present in pg_indexes", "✅"],
    ["GIN index on memory_entries.tags present", "✅"],
    ["Unique partial index on knowledge_artifacts (active)", "✅"],
    ["Migration idempotent (second run: 0 errors, 0 new rows)", "✅"],
    ["events row count: 29 → 29", "✅ No data lost"],
    ["shadowm_trades row count: 1 → 1", "✅ No data lost"],
    ["shadowm_timeline row count: 0 → 0", "✅ No data lost"],
  ],
  [370, 142]
);

// ── 9. Production Validation ───────────────────────────────────────────────
h1("9. Production Validation");
table(
  ["Check", "Result", "Notes"],
  [
    ["telemetry/server.js not modified", "✅", "0 diff lines"],
    ["telemetry/shadowm.js not modified", "✅", "0 diff lines"],
    ["telemetry/shadowlab.js not modified", "✅", "0 diff lines"],
    ["telemetry/db-adapter.js not modified", "✅", "0 diff lines"],
    ["index.js not modified", "✅", "FROZEN — 0 diff lines"],
    ["No new require() calls in production files", "✅", "grep confirmed"],
    ["Archived files have 0 active require() references", "✅", "grep confirmed"],
    ["Production bot behavior: zero change", "✅", "No code paths altered"],
    ["New DB tables are additive only", "✅", "No existing tables dropped/altered"],
  ],
  [300, 60, 152]
);

// ── 10. Risks ──────────────────────────────────────────────────────────────
h1("10. Risks");
table(
  ["ID", "Risk", "Impact", "Status"],
  [
    ["R-001", "JS SQL splitter silently drops CREATE TABLE statements", "High", "⚠ MATERIALIZED — Fixed"],
    ["R-002", "Migration destroys existing data", "Critical", "✅ Mitigated — row count guards"],
    ["R-003", "db.run() breaks on non-id PK tables", "Medium", "⚠ MATERIALIZED — Documented"],
    ["R-004", "ANY($1) pg library array serialization bug", "Medium", "⚠ MATERIALIZED — Fixed"],
    ["R-005", "New tables interfere with bot startup", "High", "✅ N/A — Sprint 0 is additive only"],
    ["R-006", "git mv blocked in Replit agent", "Low", "⚠ MATERIALIZED — Used plain mv"],
  ],
  [50, 265, 65, 132]
);

// ── 11. Lessons Learned ───────────────────────────────────────────────────
h1("11. Lessons Learned");

h3("L1 — Never use a JS regex-based SQL splitter for multi-statement DDL");
para(
  "The first version of run.js used a regex lookahead to split the SQL file on semicolons. It appeared " +
  "to work (producing 20 'statements') but silently grouped multi-line CREATE TABLE statements. Grouped " +
  "statements failed with 42P01 (table doesn't exist for the index), caught as a harmless 'SKIP'. The " +
  "seven new tables were never created. Fix: always use psql -f <file> via execSync."
);

h3("L2 — db.run() auto-appends RETURNING id — dangerous for tables without an id column");
para(
  "telemetry/db-adapter.js appends RETURNING id to every INSERT lacking a RETURNING clause. Tables with " +
  "non-BIGSERIAL primary keys (e.g. runtime_domains with PRIMARY KEY(domain)) throw 'column id does not " +
  "exist'. Fix: use db.exec() for INSERTs into tables with non-id PKs."
);

h3("L3 — ANY($1) with a JavaScript array returns zero rows in pg");
para(
  "Passing [[\"table1\", \"table2\"]] as a parameter to WHERE table_name = ANY($1) silently returns 0 rows " +
  "due to pg's type resolution for information_schema.name columns. Fix: query all rows and filter in JS."
);

h3("L4 — Node 24 test reporter flag is --test-reporter=spec, not --reporter=spec");
para(
  "--reporter=spec does not exist in Node 24's node --test. Process exits immediately with 'bad option'. " +
  "Fix: always use --test-reporter=spec. Also note: exit code may be -1 even on all-pass — check output text."
);

h3("L5 — psql is available in the Replit Nix environment");
para(
  "psql is at /nix/store/.../bin/psql at version 16.10 — no installation required. Migration scripts " +
  "can reliably use psql as their execution engine."
);

// ── 12. Known Issues ─────────────────────────────────────────────────────
h1("12. Known Issues");
table(
  ["#", "Issue", "Severity", "Status"],
  [
    ["KI-001", "db.run() fails on INSERT into tables with non-id PK (runtime_domains, event_idempotency)", "Medium", "Documented — use db.exec()"],
    ["KI-002", "node --test exits -1 even when all tests pass (Node 24 quirk with spec reporter)", "Low", "Check output text, not exit code"],
    ["KI-003", "git mv is blocked in Replit main agent", "Low", "Use plain mv — git detects rename"],
    ["KI-004", "git push from agent times out", "Low", "User must push from the Shell"],
  ],
  [30, 250, 65, 167]
);

// ── 13. Architecture Notes ────────────────────────────────────────────────
h1("13. Architecture Notes");
h2("SHADOW OS v2 Schema Overview");
para(
  "The SHADOW OS v2 schema is an event-sourced, domain-partitioned state store. The seven new tables " +
  "form three logical tiers:"
);
vSpace(4);

h3("Tier 1 — State (runtime_domains)");
para(
  "Single-table key-value store where each row is an entire domain's mutable state. Version field " +
  "enables optimistic locking. The 10 bootstrap rows pre-initialize all domain namespaces."
);

h3("Tier 2 — Intent & Memory");
bullet("trade_intents: records every OANDA order attempt before it is sent, enabling idempotent retries and reconciliation after crashes.");
bullet("memory_entries: ephemeral and persistent K/V storage with namespace scoping, TTL, and GIN-indexed tags for fast multi-tag lookup.");
bullet("event_idempotency: prevents duplicate event processing by mapping idempotency keys to event IDs.");

h3("Tier 3 — Knowledge & Audit");
bullet("knowledge_artifacts: versioned snapshots of trained strategy models (KNN weights, condition tables). A partial unique index ensures exactly one 'active' artifact per (domain, artifact) pair. Old versions are retained forever — knowledge is never deleted.");
bullet("consistency_log: append-only audit trail of self-detected data integrity issues, with severity levels and resolution tracking.");
bullet("system_snapshots: point-in-time captures of the full system state taken at key decision points.");

h2("Design Invariants");
bullet("Existing tables are never altered — only indexes are added with IF NOT EXISTS.");
bullet("All new tables are append-friendly — the bot can be restarted at any point without corrupt state.");
bullet("runtime_domains is the single source of truth for all mutable domain state.");
bullet("knowledge_artifacts uses a superseded_at pattern — knowledge is never deleted, enabling rollback and audit.");

// ── 14. Migration Checklist ───────────────────────────────────────────────
h1("14. Migration Checklist");
table(
  ["Step", "Description", "Status"],
  [
    ["MC-01", "Confirm DATABASE_URL is set and points to PostgreSQL", "✅ Done"],
    ["MC-02", "Verify psql is available in the execution environment", "✅ Done"],
    ["MC-03", "Read and validate 001_shadow_os_v2_schema.sql for correctness", "✅ Done"],
    ["MC-04", "Capture pre-migration row counts for all existing tables", "✅ Done"],
    ["MC-05", "Run node telemetry/migrations/run.js (first pass)", "✅ Done"],
    ["MC-06", "Verify all 10 tables exist in information_schema.tables", "✅ Done"],
    ["MC-07", "Verify all 10 runtime_domains rows are present", "✅ Done"],
    ["MC-08", "Verify post-migration row counts equal pre-migration counts", "✅ Done"],
    ["MC-09", "Run node telemetry/migrations/run.js (second pass — idempotency)", "✅ Done"],
    ["MC-10", "Confirm second pass produces 0 errors", "✅ Done"],
    ["MC-11", "Run node --test smoke.test.js — 8/8 pass", "✅ Done"],
    ["MC-12", "Run node --test schema.test.js — 11/11 pass", "✅ Done"],
    ["MC-13", "git diff confirms 0 lines changed in active production files", "✅ Done"],
  ],
  [50, 310, 152]
);

// ── 15. Validation Checklist ──────────────────────────────────────────────
h1("15. Validation Checklist");
table(
  ["Gate", "Criterion", "Pass Condition", "Status"],
  [
    ["GATE-0.A", "Dead code archived", "8 files in archive/, 0 active require() refs", "✅ PASS"],
    ["GATE-0.B", "Test framework operational", "node --test runs; at least 1 test passes", "✅ PASS"],
    ["GATE-0.C", "Migration SQL complete", "All 7 new tables + indexes + bootstrap", "✅ PASS"],
    ["GATE-0.D", "Migration runs clean", "Runner exits 0; all 10 tables verified", "✅ PASS"],
    ["GATE-0.E", "Migration is idempotent", "Second run exits 0 with same output", "✅ PASS"],
    ["GATE-0.F", "Zero active code modified", "git diff on 5 active files = 0 lines", "✅ PASS"],
    ["GATE-0.G", "All tests pass", "19/19 pass (8 smoke + 11 schema)", "✅ PASS"],
  ],
  [70, 160, 190, 92]
);

// ── 16. Sprint Status ─────────────────────────────────────────────────────
h1("16. Sprint Status");
checkY(110);
doc.save()
   .rect(MARGIN, y, CONTENT_W, 90)
   .fill(C.greenBg)
   .restore();
doc.save()
   .rect(MARGIN, y, CONTENT_W, 90)
   .lineWidth(1.5).strokeColor(C.green).stroke()
   .restore();
doc.save()
   .rect(MARGIN, y, 6, 90)
   .fill(C.green)
   .restore();

doc.font(F.bold).fontSize(18).fillColor(C.green)
   .text("✅  SPRINT 0 PASSED", MARGIN + 18, y + 14, { width: CONTENT_W - 24 });
doc.font(F.regular).fontSize(9).fillColor(C.darkGray)
   .text(
     `Date: 2026-07-06    |    Commit: dc2a2791e97fb074b7df10c7ba51ae3a7d2fbdf9\n` +
     `Tests: 19/19 PASS    |    Data lost: 0 rows    |    Code changed: 0 lines\n` +
     `Gates: 7/7 PASSED`,
     MARGIN + 18, y + 44, { width: CONTENT_W - 24 }
   );
y += 100;

// ── 17. Readiness for Sprint 1 ────────────────────────────────────────────
h1("17. Readiness for Sprint 1");

h2("Sprint 1 Objective");
para("Implement RuntimeDomainManager — the first SHADOW OS v2 domain manager. Responsible for reading/writing the runtime_domains table, providing atomic version-checked updates, and bootstrapping the domain state on first boot.");

h2("Sprint 1 Prerequisites");
table(
  ["Prerequisite", "Status"],
  [
    ["runtime_domains table with correct schema", "✅ Present"],
    ["10 bootstrap domain rows", "✅ Present"],
    ["consistency_log table for error recording", "✅ Present"],
    ["system_snapshots table for state capture", "✅ Present"],
    ["Test framework operational", "✅ Operational"],
    ["Migration runner validated and idempotent", "✅ Validated"],
    ["db-adapter.js available (no changes)", "✅ Available"],
    ["Zero active code changes required to unblock Sprint 1", "✅ Confirmed"],
  ],
  [340, 172]
);

vSpace(10);
checkY(50);
doc.save()
   .rect(MARGIN, y, CONTENT_W, 36)
   .fill(C.blueBg)
   .restore();
doc.font(F.bold).fontSize(11).fillColor(C.accent)
   .text("Sprint 1 Entry Criteria — ALL MET ✅   Sprint 1 may begin immediately.", MARGIN + 16, y + 12, { width: CONTENT_W - 32 });
y += 46;

// ── Footer on last page ───────────────────────────────────────────────────
vSpace(20);
hRule(C.border);
doc.font(F.regular).fontSize(7.5).fillColor(C.lightGray)
   .text(
     "FOREX ENGINE PRO  |  Sprint 0 Report v1.0  |  SHADOW OS v2 Foundation  |  2026-07-06  |  " +
     "Commit dc2a2791e97fb074b7df10c7ba51ae3a7d2fbdf9",
     MARGIN, y, { width: CONTENT_W, align: "center" }
   );

doc.end();
console.log(`PDF written to: ${OUTPUT}`);
