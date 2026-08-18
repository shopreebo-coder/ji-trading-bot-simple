"use strict";

const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");

const INPUT = path.join(__dirname, "FOREX_ENGINE_PRO_FINAL_PRE_PUSH_FIX.md");
const OUTPUT = path.join(__dirname, "FOREX_ENGINE_PRO_FINAL_PRE_PUSH_FIX.pdf");
const W = 612;
const H = 792;
const M = 48;
const CW = W - 2 * M;
const BLUE = "#145a86";
const INK = "#1c2733";
const MUTED = "#566573";
const PALE = "#eef5f9";
const GREEN = "#e8f5ee";
const BORDER = "#c8d4dc";

const doc = new PDFDocument({
  size: "LETTER",
  margin: M,
  autoFirstPage: false,
  info: {
    Title: "FOREX ENGINE PRO — Final Pre-Push Fix",
    Author: "FOREX ENGINE PRO",
    Subject: "Deadlock fix and pre-push verification",
  },
});
doc.pipe(fs.createWriteStream(OUTPUT));

let page = 0;
let y = M;

function clean(value) {
  return String(value || "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[(.+?)\]\(.+?\)/g, "$1")
    .replace(/→/g, "->")
    .replace(/—/g, "-");
}

function newPage() {
  doc.addPage();
  page += 1;
  y = 46;
  doc.save().rect(0, 0, W, 30).fill(BLUE).restore();
  doc.font("Helvetica-Bold").fontSize(8).fillColor("#fff")
    .text("FOREX ENGINE PRO  |  FINAL PRE-PUSH FIX", M, 10);
  doc.font("Helvetica").fontSize(8).fillColor("#fff")
    .text(`Page ${page}`, W - M - 42, 10, { width: 42, align: "right" });
}

function need(height) {
  if (y + height > H - 48) newPage();
}

function paragraph(text, options = {}) {
  const indent = options.indent || 0;
  const size = options.size || 9;
  const value = clean(text);
  doc.font("Helvetica").fontSize(size);
  const height = doc.heightOfString(value, { width: CW - indent, lineGap: 1.4 });
  need(height + 5);
  doc.fillColor(options.color || INK).text(value, M + indent, y, {
    width: CW - indent,
    lineGap: 1.4,
  });
  y = doc.y + 5;
}

function heading(text, level) {
  const size = level === 1 ? 16 : level === 2 ? 12 : 10.5;
  need(level === 1 ? 42 : 30);
  y += level === 1 ? 15 : level === 2 ? 10 : 7;
  doc.font("Helvetica-Bold").fontSize(size)
    .fillColor(level === 1 ? BLUE : INK)
    .text(clean(text), M, y, { width: CW });
  y = doc.y + 3;
  if (level <= 2) {
    doc.save().moveTo(M, y).lineTo(W - M, y)
      .lineWidth(level === 1 ? 1 : 0.4)
      .strokeColor(level === 1 ? BLUE : BORDER).stroke().restore();
    y += 5;
  }
}

function bullet(text, depth = 0) {
  const indent = 12 + depth * 14;
  need(20);
  doc.font("Helvetica-Bold").fontSize(9).fillColor(BLUE)
    .text("•", M + indent - 9, y);
  paragraph(text, { indent, size: 8.8 });
}

function code(lines) {
  const content = lines.map(clean);
  const height = content.length * 10 + 14;
  need(height + 6);
  doc.save().rect(M, y, CW, height).fill(PALE).restore();
  doc.save().rect(M, y, CW, height).lineWidth(0.5)
    .strokeColor(BORDER).stroke().restore();
  doc.font("Courier").fontSize(7.2).fillColor(INK);
  let cy = y + 7;
  for (const line of content) {
    doc.text(line, M + 7, cy, { width: CW - 14, lineBreak: false });
    cy += 10;
  }
  y += height + 6;
}

function titlePage() {
  newPage();
  y = 135;
  doc.font("Helvetica-Bold").fontSize(22).fillColor(BLUE)
    .text("FINAL PRE-PUSH FIX", M, y, { width: CW, align: "center" });
  y = doc.y + 12;
  doc.font("Helvetica-Bold").fontSize(16).fillColor(INK)
    .text("FOREX ENGINE PRO", M, y, { width: CW, align: "center" });
  y = doc.y + 24;
  doc.save().roundedRect(M + 75, y, CW - 150, 42, 6).fill(GREEN).restore();
  doc.font("Helvetica-Bold").fontSize(13).fillColor("#176b45")
    .text("STATUS: READY_FOR_PUSH", M + 75, y + 14, { width: CW - 150, align: "center" });
  y += 78;
  paragraph("18 sierpnia 2026", { size: 10, color: MUTED });
  paragraph("Deadlock confirmed and fixed with a Knowledge-bootstrap baseline collection path. Publish/deploy was not executed.", {
    size: 9.5,
    color: MUTED,
  });
  y += 14;
  code([
    "Knowledge unavailable -> Capital Gate ABSTAIN",
    "-> unchanged Live baseline may collect real outcome",
    "-> Capital Gate never becomes ALLOW",
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

for (; i < lines.length; i += 1) {
  const line = lines[i];
  if (!line.trim()) {
    y += 2;
    continue;
  }
  if (/^```/.test(line)) {
    const block = [];
    i += 1;
    while (i < lines.length && !/^```/.test(lines[i])) {
      block.push(lines[i]);
      i += 1;
    }
    code(block);
    continue;
  }
  const match = line.match(/^(#{1,3})\s+(.+)/);
  if (match) {
    heading(match[2], match[1].length);
    continue;
  }
  const bulletMatch = line.match(/^(\s*)-\s+(.+)/);
  if (bulletMatch) {
    bullet(bulletMatch[2], Math.floor(bulletMatch[1].length / 2));
    continue;
  }
  paragraph(line);
}

doc.end();
doc.on("end", () => console.log(`Wrote ${OUTPUT}`));