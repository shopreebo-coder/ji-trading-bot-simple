---
name: PDF report/audit renderer contract
description: How the docs/**/generate_*_pdf.js pdfkit renderers parse Markdown — the non-obvious heading/marker rules to author MD that renders correctly.
---

The repo generates report/audit PDFs with standalone pdfkit scripts (e.g. `docs/reports/generate_sprint5_pdf.js`, `docs/audit/generate_audit_pdf.js`). To make a new PDF, clone an existing generator, repoint INPUT/OUTPUT + title/header text, run `node <script>`. No external binaries; `pdfkit` is already available.

**Markdown contract the walker enforces (author the .md to match, or content silently drops):**
- The walker **skips every line until the first `---` line**, then renders from there. So the .md MUST have a `---` separator after the title/frontmatter block; anything above it never appears in the PDF (the title page is drawn programmatically in the script).
- Heading mapping is shifted by one level: `# ` (single hash) is **skipped entirely**; `## `→H1 (accent), `### `→H2, `#### `→H3. Use `##` for top-level section headers, not `#`.
- Supported inline/blocks: GitHub tables (`| … |` with `---` separator row), fenced code blocks (```), `**bold**`, `- ` bullets (depth = leading spaces / 2), `> ` blockquote, lines starting with ✅ get a green callout.
- Tables auto-scale columns to content width; keep cells short and cap column count (~10) or text gets cramped. Tune `min col width` / font size in the `table()` fn for wide tables.

**Why:** the renderer is a hand-rolled line walker, not a real Markdown parser; these three rules (first-`---` gate, single-`#` skip, shifted heading levels) are invisible unless you read the generator, and getting them wrong makes whole sections vanish from the PDF with no error.
