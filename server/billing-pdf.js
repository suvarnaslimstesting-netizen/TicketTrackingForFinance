// Quotation and Tax Invoice PDFs (A4 portrait).
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const { stateName, amountInWords } = require('./gst');

const LOGO = path.join(__dirname, '..', 'public', 'img', 'suvarna-logo.png');
const BRAND = '#2C6A98';
const INK = '#1F2937';
const MUTED = '#6B7280';
const LINE = '#D5DCE5';

const money = (n) => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qty = (n) => Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const dmy = (iso) => (iso ? iso.slice(0, 10).split('-').reverse().join('-') : '');
const safeName = (s) => String(s).replace(/[^A-Za-z0-9-]+/g, '-');

/**
 * kind: 'quotation' | 'invoice'
 * doc:  the quotation or invoice row
 * ctx:  { company, client, approval, quotation (for invoice), po (for invoice) }
 */
function billingPdf(res, kind, doc, ctx) {
  const { company: co, client, approval } = ctx;
  const isInv = kind === 'invoice';
  const number = isInv ? doc.invoice_no : `${doc.quote_no}${doc.revision ? ` Rev ${doc.revision}` : ''}`;

  const pdf = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true, info: { Title: `${isInv ? 'Tax Invoice' : 'Quotation'} ${number}`, Author: co.company_name } });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${isInv ? 'Invoice' : 'Quotation'}-${safeName(number)}.pdf"`);
  pdf.pipe(res);

  const L = pdf.page.margins.left;
  const W = pdf.page.width - L - pdf.page.margins.right;
  const R = L + W;

  /* ---- Header ---- */
  if (fs.existsSync(LOGO)) pdf.image(LOGO, L, 36, { width: 160 });
  pdf.font('Helvetica-Bold').fontSize(20).fillColor(BRAND).text(isInv ? 'TAX INVOICE' : 'QUOTATION', L, 38, { width: W, align: 'right' });
  pdf.font('Helvetica').fontSize(9).fillColor(INK);
  const meta = isInv
    ? [['Invoice No', number], ['Invoice Date', dmy(doc.invoice_date)], ['Due Date', dmy(doc.due_date)]]
    : [['Quotation No', number], ['Date', dmy(doc.quote_date)], ['Valid Until', dmy(doc.valid_until)]];
  let my = 64;
  for (const [k, v] of meta) {
    if (!v) continue;
    pdf.font('Helvetica').fillColor(MUTED).text(`${k}: `, L, my, { width: W - 110, align: 'right', continued: false });
    pdf.font('Helvetica-Bold').fillColor(INK).text(v, R - 108, my, { width: 108, align: 'right' });
    my += 13;
  }
  let y = Math.max(my, 100) + 8;
  pdf.moveTo(L, y).lineTo(R, y).lineWidth(1.2).strokeColor(BRAND).stroke();
  y += 10;

  /* ---- From / Bill To ---- */
  const colW = (W - 20) / 2;
  const block = (x, title, lines) => {
    pdf.font('Helvetica-Bold').fontSize(8).fillColor(BRAND).text(title, x, y, { width: colW, characterSpacing: 0.6 });
    let yy = pdf.y + 3;
    lines.filter((l) => l && l[1]).forEach(([style, text], i) => {
      pdf.font(style === 'b' ? 'Helvetica-Bold' : 'Helvetica').fontSize(style === 'b' && i === 0 ? 10.5 : 8.8).fillColor(style === 'm' ? MUTED : INK)
        .text(text, x, yy, { width: colW });
      yy = pdf.y + 1.5;
    });
    return yy;
  };
  const coState = co.state_code ? `${stateName(co.state_code)} (Code ${co.state_code})` : '';
  const clState = client.state_code ? `${stateName(client.state_code)} (Code ${client.state_code})` : '';
  const y1 = block(L, 'FROM', [
    ['b', co.company_name], ['n', co.address], ['n', coState && `State: ${coState}`],
    ['n', co.gstin && `GSTIN: ${co.gstin}`], ['n', co.pan && `PAN: ${co.pan}`],
    ['m', [co.email, co.phone].filter(Boolean).join('  |  ')],
  ]);
  const y2 = block(L + colW + 20, isInv ? 'BILL TO' : 'QUOTATION FOR', [
    ['b', client.name], ['n', client.billing_address], ['n', clState && `State: ${clState}`],
    ['n', client.gstin && `GSTIN: ${client.gstin}`],
    ['m', [client.contact_person && `Attn: ${client.contact_person}`, client.contact_email].filter(Boolean).join('  |  ')],
  ]);
  y = Math.max(y1, y2) + 10;

  /* ---- Reference strip ---- */
  const refs = [['Ticket No', approval.ticket_number]];
  if (isInv) {
    refs.push(['Place of Supply', client.state_code ? `${stateName(client.state_code)} (${client.state_code})` : '—']);
    refs.push(['Quotation Ref', ctx.quotation ? `${ctx.quotation.quote_no}${ctx.quotation.revision ? ` Rev ${ctx.quotation.revision}` : ''}` : '—']);
    refs.push(['PO No / Date', ctx.po ? `${ctx.po.po_number} / ${dmy(ctx.po.po_date)}` : '—']);
  } else {
    refs.push(['Ticket Type', approval.ticket_type || '—'], ['Approved By', approval.approved_by || '—'], ['Approved Date', dmy(approval.approved_date) || '—']);
  }
  const rw = W / refs.length;
  pdf.rect(L, y, W, 34).fillAndStroke('#F3F6FA', LINE);
  refs.forEach(([k, v], i) => {
    pdf.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(k.toUpperCase(), L + i * rw + 8, y + 6, { width: rw - 12 });
    pdf.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(v, L + i * rw + 8, y + 17, { width: rw - 12, ellipsis: true, lineBreak: false });
  });
  y += 46;

  /* ---- Items table ---- */
  const cols = [
    { h: '#', w: 24, a: 'left' }, { h: 'Description', w: 0, a: 'left' }, { h: 'SAC', w: 52, a: 'left' },
    { h: 'Man-Days', w: 60, a: 'right' }, { h: 'Rate (Rs.)', w: 78, a: 'right' }, { h: 'Amount (Rs.)', w: 90, a: 'right' },
  ];
  cols[1].w = W - cols.reduce((s, c) => s + c.w, 0);
  const pad = 6;
  const drawRow = (vals, opts = {}) => {
    pdf.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
    const h = Math.max(...vals.map((v, i) => pdf.heightOfString(String(v), { width: cols[i].w - pad * 2 }))) + pad * 2;
    if (opts.fill) pdf.rect(L, y, W, h).fill(opts.fill);
    let x = L;
    vals.forEach((v, i) => {
      pdf.fillColor(opts.color || INK).text(String(v), x + pad, y + pad, { width: cols[i].w - pad * 2, align: cols[i].a });
      x += cols[i].w;
    });
    y += h;
    pdf.moveTo(L, y).lineTo(R, y).lineWidth(0.5).strokeColor(LINE).stroke();
  };
  drawRow(cols.map((c) => c.h), { bold: true, fill: BRAND, color: '#FFFFFF' });
  const desc = [
    `Professional services against ticket ${approval.ticket_number}`,
    doc.description,
  ].filter(Boolean).join('\n');
  drawRow(['1', desc, co.sac_code || '', qty(doc.man_days), money(doc.rate), money(doc.subtotal)]);

  /* ---- Totals ---- */
  y += 8;
  const tx = R - 250;
  const totalLine = (label, value, bold) => {
    pdf.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 10.5 : 9).fillColor(INK);
    pdf.text(label, tx, y, { width: 150, align: 'right' });
    pdf.text(value, tx + 155, y, { width: 95, align: 'right' });
    y += bold ? 18 : 14;
  };
  totalLine('Taxable Value', money(doc.subtotal));
  if (doc.tax_type === 'CGST_SGST') {
    totalLine(`CGST @ ${qty(doc.gst_rate / 2)}%`, money(doc.cgst));
    totalLine(`SGST @ ${qty(doc.gst_rate / 2)}%`, money(doc.sgst));
  } else if (doc.tax_type === 'IGST') {
    totalLine(`IGST @ ${qty(doc.gst_rate)}%`, money(doc.igst));
  }
  pdf.moveTo(tx, y - 2).lineTo(R, y - 2).lineWidth(0.8).strokeColor(BRAND).stroke();
  y += 4;
  totalLine(isInv ? 'Invoice Total (Rs.)' : 'Total (Rs.)', money(doc.total), true);

  pdf.font('Helvetica-Bold').fontSize(8.5).fillColor(MUTED).text('Amount in words', L, y + 4);
  pdf.font('Helvetica').fontSize(9).fillColor(INK).text(amountInWords(doc.total), L, pdf.y + 2, { width: W });
  y = pdf.y + 14;

  /* ---- Terms / bank / remarks ---- */
  const section = (title, text) => {
    if (!text) return;
    if (y > pdf.page.height - 170) { pdf.addPage(); y = pdf.page.margins.top; }
    pdf.font('Helvetica-Bold').fontSize(8.5).fillColor(BRAND).text(title, L, y);
    pdf.font('Helvetica').fontSize(8.6).fillColor(INK).text(text, L, pdf.y + 3, { width: W, lineGap: 1.5 });
    y = pdf.y + 12;
  };
  if (isInv) {
    section('Remarks', doc.remarks);
    const bank = [
      co.bank_name && `Bank: ${co.bank_name}${co.bank_branch ? `, ${co.bank_branch}` : ''}`,
      co.bank_account && `A/c No: ${co.bank_account}`,
      co.bank_ifsc && `IFSC: ${co.bank_ifsc}`,
      `A/c Name: ${co.company_name}`,
    ].filter(Boolean).join('\n');
    if (co.bank_account) section('Bank Details for Payment', bank);
    section('Terms & Conditions', co.invoice_terms);
  } else {
    section('Terms & Conditions', [doc.terms, co.quotation_terms].filter(Boolean).join('\n'));
  }

  /* ---- Signature ---- */
  if (y > pdf.page.height - 120) { pdf.addPage(); y = pdf.page.margins.top; }
  y += 6;
  pdf.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(`For ${co.company_name}`, R - 220, y, { width: 220, align: 'right' });
  pdf.font('Helvetica').fontSize(8.5).fillColor(MUTED).text('Authorised Signatory', R - 220, y + 44, { width: 220, align: 'right' });

  const range = pdf.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    pdf.switchToPage(i);
    const fy = pdf.page.height - 28;
    pdf.page.margins.bottom = 0; // writing in the bottom margin must not start a new page
    pdf.font('Helvetica').fontSize(7).fillColor('#9CA3AF')
      .text('This is a computer-generated document.', L, fy, { width: W / 2, lineBreak: false })
      .text(`Page ${i + 1} of ${range.count}`, L + W / 2, fy, { width: W / 2, align: 'right', lineBreak: false });
  }
  pdf.end();
}

module.exports = { billingPdf };
