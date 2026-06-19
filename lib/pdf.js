// lib/pdf.js
// -----------------------------------------------------------------------------
// Build an ATS-friendly resume PDF from the structured resume object.
// ATS-safe choices: single column, standard Helvetica font, real selectable text,
// plain uppercase section headers, simple bullets, no tables/columns/graphics.
// -----------------------------------------------------------------------------

import PDFDocument from "pdfkit";

export function buildResumePdf(resume) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "LETTER", margins: { top: 54, bottom: 54, left: 60, right: 60 } });
      const chunks = [];
      doc.on("data", (d) => chunks.push(d));
      doc.on("end", () => resolve(Buffer.concat(chunks)));

      const r = resume || {};
      const c = r.contact || {};
      const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;

      // Header: name
      if (r.name) doc.font("Helvetica-Bold").fontSize(20).fillColor("#111").text(r.name, { align: "left" });
      // Contact line
      const contactBits = [c.email, c.phone, c.location, ...((c.links) || [])].filter(Boolean);
      if (contactBits.length) {
        doc.moveDown(0.2).font("Helvetica").fontSize(9.5).fillColor("#444").text(contactBits.join("  |  "));
      }
      doc.moveDown(0.6);

      const heading = (t) => {
        doc.moveDown(0.5).font("Helvetica-Bold").fontSize(11).fillColor("#111").text(t.toUpperCase());
        const y = doc.y + 2;
        doc.moveTo(doc.page.margins.left, y).lineTo(doc.page.margins.left + width, y).strokeColor("#999").lineWidth(0.7).stroke();
        doc.moveDown(0.4);
      };
      const body = (t, opts = {}) => doc.font("Helvetica").fontSize(10).fillColor("#222").text(t, opts);

      if (r.summary) { heading("Summary"); body(r.summary); }

      if (Array.isArray(r.skills) && r.skills.length) {
        heading("Skills");
        body(r.skills.join("  •  "));
      }

      if (Array.isArray(r.experience) && r.experience.length) {
        heading("Experience");
        r.experience.forEach((e, i) => {
          if (i > 0) doc.moveDown(0.4);
          const title = [e.title, e.company].filter(Boolean).join(" — ");
          doc.font("Helvetica-Bold").fontSize(10.5).fillColor("#111").text(title || "", { continued: false });
          const meta = [e.location, e.dates].filter(Boolean).join("  |  ");
          if (meta) doc.font("Helvetica-Oblique").fontSize(9.5).fillColor("#555").text(meta);
          doc.moveDown(0.15);
          (e.bullets || []).filter(Boolean).forEach((b) => {
            doc.font("Helvetica").fontSize(10).fillColor("#222").text("•  " + b, { indent: 8, lineGap: 1 });
          });
        });
      }

      if (Array.isArray(r.education) && r.education.length) {
        heading("Education");
        r.education.forEach((ed) => {
          const line = [ed.degree, ed.school].filter(Boolean).join(" — ");
          doc.font("Helvetica-Bold").fontSize(10).fillColor("#111").text(line || "", { continued: !!ed.dates });
          if (ed.dates) doc.font("Helvetica").fontSize(9.5).fillColor("#555").text("   " + ed.dates);
        });
      }

      if (Array.isArray(r.certifications) && r.certifications.length) {
        heading("Certifications");
        body(r.certifications.join("  •  "));
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
