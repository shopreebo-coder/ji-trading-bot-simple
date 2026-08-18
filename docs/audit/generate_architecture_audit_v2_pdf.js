"use strict";

/**
 * Generates the downloadable PDF companion for
 * FOREX_ENGINE_PRO_ARCHITECTURE_AUDIT_v2.md.
 * Run: node docs/audit/generate_architecture_audit_v2_pdf.js
 */

const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");

const INPUT = path.join(__dirname, "FOREX_ENGINE_PRO_ARCHITECTURE_AUDIT_v2.md");
const OUTPUT = path.join(__dirname, "FOREX_ENGINE_PRO_ARCHITECTURE_AUDIT_v2.pdf");

const doc = new PDFDocument({
  size: "LETTER",
  margin: 48,
  autoFirstPage: false,
  info: {
    Title: "FOREX ENGINE PRO — Audyt architektury współpracy",
    Author: "FOREX ENGINE PRO",
    Subject: "Live / Shadow / Selected architecture audit",
  },
});
doc.pipe(fs.createWriteStream(OUTPUT));

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 48;
const CONTENT_W = PAGE_W - MARGIN * 2;
const COLORS = {
  ink: "#1c2733",
  muted: "#566573",
  accent: "#145a86",
  pale: "#eef5f9",
  border: "#c8d4dc",
  green: "#176b45",
  greenPale: "#e8f5ee",
  amber: "#875b00",
  amberPale: "#fff8e6",
};

let page = 0;
let y = MARGIN;

function newPage() {
  doc.addPage();
  page += 1;
  y = 46;
  doc.save().rect(0, 0, PAGE_W, 30).fill(COLORS.accent).restore();
  doc.font("Helvetica-Bold").fontSize(8).fillColor("#fff")
    .text("FOREX ENGINE PRO  |  ARCHITECTURE AUDIT v2.0", MARGIN, 10);
  doc.font("Helvetica").fontSize(8).fillColor("#fff")
    .text(`Page ${page}`, PAGE_W - MARGIN - 42, 10, { width: 42, align: "right" });
}

function need(height) {
  if (y + height > PAGE_H - 48) newPage();
}

function strip(text) {
  return String(text || "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[(.+?)\]\(.+?\)/g, "$1")
    .replace(/✅/g, "PASS")
    .replace(/❌/g, "FAIL");
}

function paragraph(text, opts = {}) {
  const size = opts.size || 8.9;
  const indent = opts.indent || 0;
  const color = opts.color || COLORS.ink;
  const clean = strip(text);
  doc.font("Helvetica").fontSize(size);
  const height = doc.heightOfString(clean, { width: CONTENT_W - indent, lineGap: 1.5 });
  need(height + 5);
  doc.fillColor(color).text(clean, MARGIN + indent, y, {
    width: CONTENT_W - indent,
    lineGap: 1.5,
  });
  y = doc.y + 5;
}

function heading(text, level) {
  const sizes = { 1: 16, 2: 12.5, 3: 10.5 };
  const gaps = { 1: 15, 2: 10, 3: 7 };
  const size = sizes[level] || 10;
  need(level === 1 ? 42 : 30);
  y += gaps[level] || 7;
  doc.font("Helvetica-Bold").fontSize(size).fillColor(level === 1 ? COLORS.accent : COLORS.ink)
    .text(strip(text), MARGIN, y, { width: CONTENT_W });
  y = doc.y + 3;
  if (level <= 2) {
    doc.save().moveTo(MARGIN, y).lineTo(PAGE_W - MARGIN, y)
      .lineWidth(level === 1 ? 1 : 0.4).strokeColor(level === 1 ? COLORS.accent : COLORS.border)
      .stroke().restore();
    y += 5;
  }
}

function bullet(text, depth = 0) {
  const indent = 12 + depth * 14;
  need(20);
  doc.font("Helvetica-Bold").fontSize(9).fillColor(COLORS.accent)
    .text("•", MARGIN + indent - 9, y);
  paragraph(text, { indent, size: 8.8 });
}

function code(lines) {
  const content = lines.map(strip);
  const lineH = 10;
  const height = content.length * lineH + 14;
  need(Math.min(height, 300) + 6);
  doc.save().rect(MARGIN, y, CONTENT_W, height).fill(COLORS.pale).restore();
  doc.save().rect(MARGIN, y, CONTENT_W, height).lineWidth(0.5)
    .strokeColor(COLORS.border).stroke().restore();
  doc.font("Courier").fontSize(7.2).fillColor(COLORS.ink);
  let cy = y + 7;
  for (const line of content) {
    doc.text(line, MARGIN + 7, cy, { width: CONTENT_W - 14, lineBreak: false });
    cy += lineH;
  }
  y += height + 6;
}

function table(rows) {
  if (!rows.length) return;
  const cells = rows.map((r) => r.map(strip));
  const cols = Math.max(...cells.map((r) => r.length));
  const widths = [0.19, 0.18, 0.35, 0.28];
  const colW = Array.from({ length: cols }, (_, i) => CONTENT_W * (widths[i] || 1 / cols));
  const draw = (row, header) => {
    const size = header ? 7.0 : 6.8;
    const measuredHeights = row.map((cell, i) =>
      doc.font(header ? "Helvetica-Bold" : "Helvetica").fontSize(size)
        .heightOfString(cell, { width: (colW[i] || CONTENT_W / cols) - 7 })
    );
    const height = Math.max(18, ...measuredHeights) + 8;
    need(height + 2);
    if (header) doc.save().rect(MARGIN, y, CONTENT_W, height).fill(COLORS.accent).restore();
    else if (row.some((v) => /CONNECTED|PASS/.test(v))) {
      doc.save().rect(MARGIN, y, CONTENT_W, height).fill(COLORS.greenPale).restore();
    }
    let x = MARGIN;
    for (let i = 0; i < cols; i += 1) {
      const w = colW[i] || CONTENT_W / cols;
      doc.font(header ? "Helvetica-Bold" : "Helvetica").fontSize(size)
        .fillColor(header ? "#fff" : COLORS.ink)
        .text(row[i] || "", x + 3, y + 4, { width: w - 6 });
      x += w;
    }
    doc.save().rect(MARGIN, y, CONTENT_W, height).lineWidth(0.35)
      .strokeColor(COLORS.border).stroke().restore();
    y += height;
  };
  draw(cells[0], true);
  cells.slice(1).forEach((row) => draw(row, false));
  y += 7;
}

function titlePage() {
  newPage();
  y = 130;
  doc.font("Helvetica-Bold").fontSize(24).fillColor(COLORS.accent)
    .text("ARCHITECTURE AUDIT", MARGIN, y, { width: CONTENT_W, align: "center" });
  y = doc.y + 7;
  doc.font("Helvetica-Bold").fontSize(17).fillColor(COLORS.ink)
    .text("FOREX ENGINE PRO", MARGIN, y, { width: CONTENT_W, align: "center" });
  y = doc.y + 14;
  doc.font("Helvetica").fontSize(11).fillColor(COLORS.muted)
    .text("Live / Shadow / Selected cooperation contract", MARGIN, y, {
      width: CONTENT_W, align: "center",
    });
  y = doc.y + 24;
  doc.save().roundedRect(MARGIN + 75, y, CONTENT_W - 150, 42, 6).fill(COLORS.amberPale).restore();
  doc.font("Helvetica-Bold").fontSize(13).fillColor(COLORS.amber)
    .text("FINAL STATUS: PARTIALLY CONNECTED", MARGIN + 75, y + 14, {
      width: CONTENT_W - 150, align: "center",
    });
  y += 76;
  paragraph("Wersja 2.0 — 2026-08-18", { size: 10, color: COLORS.muted });
  paragraph("Raport wygenerowany z aktualnego kodu źródłowego. Nie wykonano deployu, nie zmieniono kodu produkcyjnego i nie wykonano broker call.", {
    size: 9.5,
    color: COLORS.muted,
  });
  y += 12;
  doc.save().rect(MARGIN, y, CONTENT_W, 112).fill(COLORS.pale).restore();
  doc.save().rect(MARGIN, y, CONTENT_W, 112).lineWidth(0.5).strokeColor(COLORS.border).stroke().restore();
  paragraph("Najważniejsze ustalenie:", { indent: 12, size: 9.5, color: COLORS.accent });
  paragraph("Shadow Gate widzi bieżący sygnał, Selected Advisor może dostać bieżące advisory, lecz Selected Engine czyta persisted research evidence, którego producent nie obserwuje tego samego zakresu lifecycle co direct advisory.", {
    indent: 12, size: 9.3,
  });
  paragraph("Selected Engine może też zwrócić BLOCK dla high-confidence NO_TRADE, a Shadow M może wpływać na MOVE_BE / MOVE_SL. Nie należy więc opisywać całego systemu jako observation-only.", {
    indent: 12, size: 9.3,
  });
}

titlePage();
newPage();

const md = fs.readFileSync(INPUT, "utf8").split(/\r?\n/);
let i = 0;
while (i < md.length && !/^---\s*$/.test(md[i])) i += 1;
i += 1;

let tableRows = [];
const flushTable = () => {
  if (tableRows.length) table(tableRows);
  tableRows = [];
};

for (; i < md.length; i += 1) {
  const line = md[i];
  if (/^\s*\|/.test(line)) {
    const row = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    if (!row.every((c) => /^:?-{2,}:?$/.test(c))) tableRows.push(row);
    continue;
  }
  flushTable();
  if (/^```/.test(line)) {
    const lines = [];
    i += 1;
    while (i < md.length && !/^```/.test(md[i])) {
      lines.push(md[i]);
      i += 1;
    }
    code(lines);
    continue;
  }
  if (/^#\s/.test(line)) continue;
  if (/^##\s/.test(line)) { heading(line.replace(/^##\s+/, ""), 1); continue; }
  if (/^###\s/.test(line)) { heading(line.replace(/^###\s+/, ""), 2); continue; }
  if (/^####\s/.test(line)) { heading(line.replace(/^####\s+/, ""), 3); continue; }
  if (/^\s*$/.test(line) || /^---\s*$/.test(line)) continue;
  const match = line.match(/^(\s*)-\s+(.*)$/);
  if (match) { bullet(match[2], Math.floor(match[1].length / 2)); continue; }
  if (/^>\s/.test(line)) {
    paragraph(line.replace(/^>\s+/, ""), { indent: 12, color: COLORS.muted });
    continue;
  }
  paragraph(line);
}
flushTable();
doc.end();
console.log(`PDF written to: ${OUTPUT}`);
