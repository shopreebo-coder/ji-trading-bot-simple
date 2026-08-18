"use strict";

const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");

const INPUT = path.join(__dirname, "FOREX_ENGINE_PRO_SHADOW_QUALITY_PHASE3.md");
const OUTPUT = path.join(__dirname, "FOREX_ENGINE_PRO_SHADOW_QUALITY_PHASE3.pdf");
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
  greenPale: "#e8f5ee",
};

const doc = new PDFDocument({
  size: "LETTER",
  margin: MARGIN,
  autoFirstPage: false,
  info: {
    Title: "FOREX ENGINE PRO — Shadow Quality Audit Phase 3/3",
    Author: "FOREX ENGINE PRO",
    Subject: "Shadow A/B/C/M quality, Knowledge and controlled safety audit",
  },
});
doc.pipe(fs.createWriteStream(OUTPUT));

let page = 0;
let y = MARGIN;

function clean(text) {
  return String(text || "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[(.+?)\]\(.+?\)/g, "$1")
    .replace(/→/g, "->")
    .replace(/—/g, "-")
    .replace(/✅/g, "PASS")
    .replace(/❌/g, "FAIL");
}

function newPage() {
  doc.addPage();
  page += 1;
  y = 46;
  doc.save().rect(0, 0, PAGE_W, 30).fill(COLORS.accent).restore();
  doc.font("Helvetica-Bold").fontSize(8).fillColor("#fff")
    .text("FOREX ENGINE PRO  |  SHADOW QUALITY AUDIT PHASE 3/3", MARGIN, 10);
  doc.font("Helvetica").fontSize(8).fillColor("#fff")
    .text(`Page ${page}`, PAGE_W - MARGIN - 42, 10, { width: 42, align: "right" });
}

function need(height) {
  if (y + height > PAGE_H - 48) newPage();
}

function paragraph(text, opts = {}) {
  const indent = opts.indent || 0;
  const size = opts.size || 9;
  const content = clean(text);
  doc.font("Helvetica").fontSize(size);
  const height = doc.heightOfString(content, { width: CONTENT_W - indent, lineGap: 1.4 });
  need(height + 5);
  doc.fillColor(opts.color || COLORS.ink).text(content, MARGIN + indent, y, {
    width: CONTENT_W - indent,
    lineGap: 1.4,
  });
  y = doc.y + 5;
}

function heading(text, level) {
  const size = level === 1 ? 16 : level === 2 ? 12 : 10.5;
  need(level === 1 ? 42 : 30);
  y += level === 1 ? 15 : level === 2 ? 10 : 7;
  doc.font("Helvetica-Bold").fontSize(size)
    .fillColor(level === 1 ? COLORS.accent : COLORS.ink)
    .text(clean(text), MARGIN, y, { width: CONTENT_W });
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
  const content = lines.map(clean);
  const height = content.length * 10 + 14;
  need(height + 6);
  doc.save().rect(MARGIN, y, CONTENT_W, height).fill(COLORS.pale).restore();
  doc.save().rect(MARGIN, y, CONTENT_W, height).lineWidth(0.5)
    .strokeColor(COLORS.border).stroke().restore();
  doc.font("Courier").fontSize(7.2).fillColor(COLORS.ink);
  let cy = y + 7;
  for (const line of content) {
    doc.text(line, MARGIN + 7, cy, { width: CONTENT_W - 14, lineBreak: false });
    cy += 10;
  }
  y += height + 6;
}

function table(rows) {
  const cells = rows.map((row) => row.map(clean));
  const cols = Math.max(...cells.map((row) => row.length));
  const widths = cols === 3 ? [0.22, 0.28, 0.50] : Array(cols).fill(1 / cols);
  const colW = widths.map((v) => CONTENT_W * v);
  cells.forEach((row, rowIndex) => {
    const header = rowIndex === 0;
    const size = header ? 7 : 7.2;
    const heights = row.map((cell, i) => doc.font(header ? "Helvetica-Bold" : "Helvetica")
      .fontSize(size).heightOfString(cell, { width: colW[i] - 7 }));
    const height = Math.max(18, ...heights) + 8;
    need(height + 2);
    if (header) doc.save().rect(MARGIN, y, CONTENT_W, height).fill(COLORS.accent).restore();
    if (!header && row.some((cell) => /PASS|ALLOW|BLOCK/.test(cell))) {
      doc.save().rect(MARGIN, y, CONTENT_W, height).fill(COLORS.greenPale).restore();
    }
    let x = MARGIN;
    for (let i = 0; i < cols; i += 1) {
      doc.font(header ? "Helvetica-Bold" : "Helvetica").fontSize(size)
        .fillColor(header ? "#fff" : COLORS.ink).text(row[i] || "", x + 3, y + 4, { width: colW[i] - 6 });
      x += colW[i];
    }
    doc.save().rect(MARGIN, y, CONTENT_W, height).lineWidth(0.35)
      .strokeColor(COLORS.border).stroke().restore();
    y += height;
  });
  y += 7;
}

function titlePage() {
  newPage();
  y = 130;
  doc.font("Helvetica-Bold").fontSize(23).fillColor(COLORS.accent)
    .text("SHADOW QUALITY AUDIT", MARGIN, y, { width: CONTENT_W, align: "center" });
  y = doc.y + 8;
  doc.font("Helvetica-Bold").fontSize(17).fillColor(COLORS.ink)
    .text("FOREX ENGINE PRO", MARGIN, y, { width: CONTENT_W, align: "center" });
  y = doc.y + 16;
  doc.font("Helvetica").fontSize(11).fillColor(COLORS.muted)
    .text("Phase 3/3 — Shadow A/B/C/M, Selected, Knowledge and Capital Gate", MARGIN, y, {
      width: CONTENT_W, align: "center",
    });
  y = doc.y + 28;
  doc.save().roundedRect(MARGIN + 70, y, CONTENT_W - 140, 42, 6).fill(COLORS.greenPale).restore();
  doc.font("Helvetica-Bold").fontSize(13).fillColor("#176b45")
    .text("STATUS: AUDIT COMPLETE", MARGIN + 70, y + 14, { width: CONTENT_W - 140, align: "center" });
  y += 76;
  paragraph("18 sierpnia 2026", { size: 10, color: COLORS.muted });
  paragraph("Insufficient live data confirmed. Code and local runtime verified. Publishing was not executed.", {
    size: 9.5, color: COLORS.muted,
  });
  y += 16;
  code([
    "SHADOW OBSERVATION -> QUALITY AUDIT -> SELECTED",
    "-> KNOWLEDGE EVIDENCE -> CAPITAL GATE",
    "-> LIVE BOT REMAINS SOLE BROKER AUTHORITY",
  ]);
}

titlePage();
newPage();
const lines = fs.readFileSync(INPUT, "utf8").split(/\r?\n/);
let i = 0;
while (i < lines.length && !/^---\s*$/.test(lines[i])) i += 1;
i += 1;
while (i < lines.length && !/^---\s*$/.test(lines[i])) i += 1;
i += 1;
let tableRows = [];
const flushTable = () => {
  if (tableRows.length) table(tableRows);
  tableRows = [];
};
for (; i < lines.length; i += 1) {
  const line = lines[i];
  if (/^\s*\|/.test(line)) {
    const row = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
    if (!row.every((cell) => /^:?-{2,}:?$/.test(cell))) tableRows.push(row);
    continue;
  }
  flushTable();
  if (!line.trim()) { y += 2; continue; }
  if (/^```/.test(line)) {
    const block = [];
    i += 1;
    while (i < lines.length && !/^```/.test(lines[i])) { block.push(lines[i]); i += 1; }
    code(block);
    continue;
  }
  const match = line.match(/^(#{1,3})\s+(.+)/);
  if (match) { heading(match[2], match[1].length); continue; }
  const bulletMatch = line.match(/^(\s*)-\s+(.+)/);
  if (bulletMatch) { bullet(bulletMatch[2], Math.floor(bulletMatch[1].length / 2)); continue; }
  paragraph(line);
}
flushTable();
doc.end();
doc.on("end", () => console.log(`Wrote ${OUTPUT}`));