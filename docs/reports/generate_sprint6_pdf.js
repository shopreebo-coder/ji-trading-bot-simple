"use strict";
/**
 * Generates docs/reports/SPRINT_6_REPORT.pdf from SPRINT_6_REPORT.md
 * Generic markdown renderer using pdfkit — zero external binary dependencies.
 * Run: node docs/reports/generate_sprint6_pdf.js
 */

const PDFDocument = require("pdfkit");
const fs          = require("fs");
const path        = require("path");

const INPUT  = path.join(__dirname, "SPRINT_6_REPORT.md");
const OUTPUT = path.join(__dirname, "SPRINT_6_REPORT.pdf");

const md = fs.readFileSync(INPUT, "utf8");

const C = {
  black:     "#1a1a1a",
  midGray:   "#555555",
  lightGray: "#888888",
  border:    "#cccccc",
  bg:        "#f5f5f5",
  green:     "#1a7340",
  greenBg:   "#e8f5ee",
  red:       "#c0392b",
  accent:    "#2c5f8a",
  white:     "#ffffff",
  tableRow:  "#f9f9f9",
};

const F = {
  regular:  "Helvetica",
  bold:     "Helvetica-Bold",
  italic:   "Helvetica-Oblique",
  mono:     "Courier",
  monoBold: "Courier-Bold",
};

const PAGE_W    = 612;
const PAGE_H    = 792;
const MARGIN    = 54;
const CONTENT_W = PAGE_W - MARGIN * 2;

const doc = new PDFDocument({ size: "LETTER", margin: MARGIN, autoFirstPage: false });
doc.pipe(fs.createWriteStream(OUTPUT));

let pageNum = 0;
let y = MARGIN;

function newPage() {
  doc.addPage();
  pageNum++;
  y = MARGIN;
  doc.save().rect(0, 0, PAGE_W, 32).fill(C.accent).restore();
  doc.font(F.bold).fontSize(8).fillColor(C.white)
     .text("FOREX ENGINE PRO  |  SHADOW OS v2 Migration  |  Sprint 6 Report", MARGIN, 11);
  doc.font(F.regular).fontSize(8).fillColor(C.white)
     .text(`Page ${pageNum}`, PAGE_W - MARGIN - 50, 11, { width: 50, align: "right" });
  y = 48;
}

function checkY(needed) {
  if (y + needed > PAGE_H - MARGIN - 20) newPage();
}

function vSpace(n = 8) { y += n; }

function hRule(color = C.border, thick = 0.5) {
  doc.save().moveTo(MARGIN, y).lineTo(PAGE_W - MARGIN, y)
     .lineWidth(thick).strokeColor(color).stroke().restore();
  y += 6;
}

function clean(s) {
  return s
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[(.+?)\]\(.+?\)/g, "$1")
    .trim();
}

function h1(text) {
  checkY(60);
  vSpace(14);
  doc.save().rect(MARGIN, y, 4, 22).fill(C.accent).restore();
  doc.font(F.bold).fontSize(16).fillColor(C.accent)
     .text(clean(text), MARGIN + 12, y, { width: CONTENT_W - 12 });
  y = doc.y + 4;
  hRule(C.accent, 1);
}

function h2(text) {
  checkY(44);
  vSpace(10);
  doc.font(F.bold).fontSize(12.5).fillColor(C.black)
     .text(clean(text), MARGIN, y, { width: CONTENT_W });
  y = doc.y + 2;
  hRule(C.border, 0.5);
}

function h3(text) {
  checkY(34);
  vSpace(8);
  doc.font(F.bold).fontSize(10.5).fillColor(C.accent)
     .text(clean(text), MARGIN, y, { width: CONTENT_W });
  y = doc.y + 4;
}

function para(text, opts = {}) {
  const indent  = opts.indent || 0;
  const size    = opts.size || 9.5;
  const color   = opts.color || C.black;
  const width   = CONTENT_W - indent;
  const segs    = [];
  let rest = text;
  const re = /\*\*(.+?)\*\*/;
  while (true) {
    const m = rest.match(re);
    if (!m) { segs.push({ t: rest, b: false }); break; }
    if (m.index > 0) segs.push({ t: rest.slice(0, m.index), b: false });
    segs.push({ t: m[1], b: true });
    rest = rest.slice(m.index + m[0].length);
  }
  const est = doc.font(F.regular).fontSize(size)
    .heightOfString(clean(text), { width });
  checkY(est + 4);
  doc.fontSize(size).fillColor(color);
  segs.forEach((seg, i) => {
    const t = seg.t.replace(/`([^`]*)`/g, "$1");
    doc.font(seg.b ? F.bold : F.regular)
       .text(t, i === 0 ? MARGIN + indent : undefined, i === 0 ? y : undefined, {
         width, continued: i < segs.length - 1, lineGap: 1.5,
       });
  });
  y = doc.y + 5;
}

function bullet(text, depth = 0) {
  const indent = 10 + depth * 14;
  const est = doc.font(F.regular).fontSize(9.5)
    .heightOfString(clean(text), { width: CONTENT_W - indent - 10 });
  checkY(est + 4);
  doc.font(F.bold).fontSize(9.5).fillColor(C.accent)
     .text("•", MARGIN + indent - 10, y);
  const save = y;
  y = save;
  doc.fillColor(C.black);
  paraAt(text, MARGIN + indent, save, CONTENT_W - indent);
}

function paraAt(text, x, yy, width) {
  const segs = [];
  let rest = text;
  const re = /\*\*(.+?)\*\*/;
  while (true) {
    const m = rest.match(re);
    if (!m) { segs.push({ t: rest, b: false }); break; }
    if (m.index > 0) segs.push({ t: rest.slice(0, m.index), b: false });
    segs.push({ t: m[1], b: true });
    rest = rest.slice(m.index + m[0].length);
  }
  doc.fontSize(9.5).fillColor(C.black);
  segs.forEach((seg, i) => {
    const t = seg.t.replace(/`([^`]*)`/g, "$1");
    doc.font(seg.b ? F.bold : F.regular)
       .text(t, i === 0 ? x : undefined, i === 0 ? yy : undefined, {
         width, continued: i < segs.length - 1, lineGap: 1.5,
       });
  });
  y = doc.y + 3;
}

function codeBlock(lines) {
  const lineH = 11;
  const padding = 8;
  const totalH = lines.length * lineH + padding * 2;
  checkY(Math.min(totalH, 300) + 10);
  let i = 0;
  while (i < lines.length) {
    const avail = PAGE_H - MARGIN - 20 - y - padding * 2;
    const fit = Math.max(1, Math.floor(avail / lineH));
    const chunk = lines.slice(i, i + fit);
    const h = chunk.length * lineH + padding * 2;
    doc.save().rect(MARGIN, y, CONTENT_W, h).fill(C.bg).restore();
    doc.save().rect(MARGIN, y, CONTENT_W, h)
       .lineWidth(0.5).strokeColor(C.border).stroke().restore();
    let yy = y + padding;
    doc.font(F.mono).fontSize(8).fillColor(C.black);
    for (const ln of chunk) {
      doc.text(ln, MARGIN + padding, yy, { width: CONTENT_W - padding * 2, lineBreak: false });
      yy += lineH;
    }
    y += h + 4;
    i += fit;
    if (i < lines.length) newPage();
  }
  vSpace(4);
}

function table(rows) {
  if (rows.length === 0) return;
  const header = rows[0];
  const body = rows.slice(1);
  const maxLens = header.map((h, c) =>
    Math.max(clean(h).length, ...body.map(r => clean(r[c] || "").length)));
  const totalLen = maxLens.reduce((a, b) => a + b, 0) || 1;
  const widths = maxLens.map(l => Math.max(50, (l / totalLen) * CONTENT_W));
  const wSum = widths.reduce((a, b) => a + b, 0);
  const scale = CONTENT_W / wSum;
  const colW = widths.map(w => w * scale);

  function rowHeight(cells, font, size) {
    let h = 0;
    cells.forEach((cell, c) => {
      const hh = doc.font(font).fontSize(size)
        .heightOfString(clean(cell || ""), { width: colW[c] - 10 });
      h = Math.max(h, hh);
    });
    return h + 8;
  }

  function drawRow(cells, opts) {
    const h = rowHeight(cells, opts.font, opts.size);
    checkY(h + 2);
    if (opts.bg) doc.save().rect(MARGIN, y, CONTENT_W, h).fill(opts.bg).restore();
    let x = MARGIN;
    cells.forEach((cell, c) => {
      const txt = clean(cell || "");
      let color = opts.color;
      if (/✅|PASS|COMPLETE|DONE/.test(txt)) color = opts.header ? opts.color : C.green;
      if (/❌|FAIL/.test(txt) && !/0.*FAIL|FAIL.*0/i.test(txt)) color = C.red;
      doc.font(opts.font).fontSize(opts.size).fillColor(color)
         .text(txt, x + 5, y + 4, { width: colW[c] - 10 });
      x += colW[c];
    });
    doc.save().rect(MARGIN, y, CONTENT_W, h)
       .lineWidth(0.4).strokeColor(C.border).stroke().restore();
    y += h;
  }

  drawRow(header, { font: F.bold, size: 8.5, color: C.white, bg: C.accent, header: true });
  body.forEach((r, i) => {
    const isTotal = /TOTAL/.test(clean(r[0] || ""));
    drawRow(r, {
      font: isTotal ? F.bold : F.regular,
      size: 8.5,
      color: C.black,
      bg: isTotal ? C.greenBg : (i % 2 === 0 ? C.tableRow : C.white),
    });
  });
  vSpace(8);
}

// ── Title page ────────────────────────────────────────────────────────────
newPage();
vSpace(120);
doc.font(F.bold).fontSize(26).fillColor(C.accent)
   .text("SPRINT 6 COMPLETION REPORT", MARGIN, y, { width: CONTENT_W, align: "center" });
y = doc.y + 10;
doc.font(F.regular).fontSize(14).fillColor(C.midGray)
   .text("SHADOW OS v2 — Knowledge Manager Foundation", MARGIN, y, { width: CONTENT_W, align: "center" });
y = doc.y + 30;
doc.save().roundedRect(PAGE_W / 2 - 120, y, 240, 34, 6).fill(C.greenBg).restore();
doc.font(F.bold).fontSize(13).fillColor(C.green)
   .text("✓ COMPLETE — 27/27 TESTS PASS", PAGE_W / 2 - 120, y + 10, { width: 240, align: "center" });
y += 60;
doc.font(F.regular).fontSize(10).fillColor(C.lightGray)
   .text("Date: 2026-07-12    ·    Sprint 6    ·    FOREX ENGINE PRO", MARGIN, y, { width: CONTENT_W, align: "center" });

// ── Markdown walk ─────────────────────────────────────────────────────────
newPage();
const lines = md.split("\n");
let i = 0;
while (i < lines.length && !/^---\s*$/.test(lines[i])) i++;
i++;

let tableBuf = null;
function flushTable() {
  if (tableBuf && tableBuf.length) table(tableBuf);
  tableBuf = null;
}

for (; i < lines.length; i++) {
  const line = lines[i];

  if (/^\s*\|/.test(line)) {
    const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(s => s.trim());
    if (cells.every(c => /^:?-{2,}:?$/.test(c))) continue;
    if (!tableBuf) tableBuf = [];
    tableBuf.push(cells);
    continue;
  }
  flushTable();

  if (/^```/.test(line)) {
    const buf = [];
    i++;
    while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
    codeBlock(buf);
    continue;
  }

  if (/^#\s/.test(line))   { continue; }
  if (/^##\s/.test(line))  { h1(line.replace(/^##\s+/, "")); continue; }
  if (/^###\s/.test(line)) { h2(line.replace(/^###\s+/, "")); continue; }
  if (/^####\s/.test(line)){ h3(line.replace(/^####\s+/, "")); continue; }
  if (/^---\s*$/.test(line)) { continue; }
  if (/^\s*$/.test(line))  { continue; }

  const bm = line.match(/^(\s*)-\s+(.*)$/);
  if (bm) { bullet(bm[2], Math.floor(bm[1].length / 2)); continue; }

  if (/^✅/.test(line)) {
    const est = doc.font(F.regular).fontSize(9.5)
      .heightOfString(clean(line), { width: CONTENT_W - 16 });
    checkY(est + 6);
    doc.save().rect(MARGIN, y - 2, CONTENT_W, est + 8).fill(C.greenBg).restore();
    doc.font(F.bold).fontSize(9.5).fillColor(C.green)
       .text("✓", MARGIN + 5, y + 2);
    doc.font(F.regular).fontSize(9.5).fillColor(C.black)
       .text(clean(line.replace(/^✅\s*/, "")), MARGIN + 20, y + 2, { width: CONTENT_W - 26 });
    y = doc.y + 8;
    continue;
  }

  if (/^>\s/.test(line)) {
    para(line.replace(/^>\s+/, ""), { indent: 12, color: C.midGray });
    continue;
  }

  para(line);
}
flushTable();

doc.end();
console.log(`PDF written to: ${OUTPUT}`);
