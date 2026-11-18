// GST helpers: Indian states with GST state codes, financial year, money rounding and amount in words.

const STATES = [
  ['01', 'Jammu and Kashmir'], ['02', 'Himachal Pradesh'], ['03', 'Punjab'], ['04', 'Chandigarh'], ['05', 'Uttarakhand'],
  ['06', 'Haryana'], ['07', 'Delhi'], ['08', 'Rajasthan'], ['09', 'Uttar Pradesh'], ['10', 'Bihar'], ['11', 'Sikkim'],
  ['12', 'Arunachal Pradesh'], ['13', 'Nagaland'], ['14', 'Manipur'], ['15', 'Mizoram'], ['16', 'Tripura'], ['17', 'Meghalaya'],
  ['18', 'Assam'], ['19', 'West Bengal'], ['20', 'Jharkhand'], ['21', 'Odisha'], ['22', 'Chhattisgarh'], ['23', 'Madhya Pradesh'],
  ['24', 'Gujarat'], ['26', 'Dadra and Nagar Haveli and Daman and Diu'], ['27', 'Maharashtra'], ['29', 'Karnataka'], ['30', 'Goa'],
  ['31', 'Lakshadweep'], ['32', 'Kerala'], ['33', 'Tamil Nadu'], ['34', 'Puducherry'], ['35', 'Andaman and Nicobar Islands'],
  ['36', 'Telangana'], ['37', 'Andhra Pradesh'], ['38', 'Ladakh'], ['97', 'Other Territory'], ['96', 'Outside India (Export)'],
].map(([code, name]) => ({ code, name }));

const stateName = (code) => (STATES.find((s) => s.code === code) || {}).name || '';

// Indian financial year (April–March) of an ISO date, e.g. 2026-11-18 -> "2026-27".
function finYear(iso) {
  const y = +iso.slice(0, 4);
  const m = +iso.slice(5, 7);
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Totals for man-days × rate with GST split as CGST+SGST (same state) or IGST.
function computeTotals({ man_days, rate, gst_rate, tax_type }) {
  const subtotal = round2(man_days * rate);
  let cgst = 0, sgst = 0, igst = 0;
  if (tax_type === 'IGST') igst = round2((subtotal * gst_rate) / 100);
  else if (tax_type === 'CGST_SGST') { cgst = round2((subtotal * gst_rate) / 200); sgst = cgst; }
  return { subtotal, cgst, sgst, igst, total: round2(subtotal + cgst + sgst + igst) };
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen',
  'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function twoDigits(n) {
  if (n < 20) return ONES[n];
  return `${TENS[Math.floor(n / 10)]}${n % 10 ? ' ' + ONES[n % 10] : ''}`;
}
function threeDigits(n) {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return [h ? `${ONES[h]} Hundred` : '', r ? twoDigits(r) : ''].filter(Boolean).join(' ');
}
// Indian numbering: crore, lakh, thousand.
function intWords(n) {
  if (n === 0) return 'Zero';
  const parts = [];
  const crore = Math.floor(n / 10000000); n %= 10000000;
  const lakh = Math.floor(n / 100000); n %= 100000;
  const thousand = Math.floor(n / 1000); n %= 1000;
  if (crore) parts.push(`${intWords(crore)} Crore`);
  if (lakh) parts.push(`${twoDigits(lakh)} Lakh`);
  if (thousand) parts.push(`${twoDigits(thousand)} Thousand`);
  if (n) parts.push(threeDigits(n));
  return parts.join(' ');
}
function amountInWords(amount) {
  const paise = Math.round(amount * 100);
  const rupees = Math.floor(paise / 100);
  const p = paise % 100;
  return `Rupees ${intWords(rupees)}${p ? ` and ${twoDigits(p)} Paise` : ''} Only`;
}

const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

module.exports = { STATES, stateName, finYear, round2, computeTotals, amountInWords, GSTIN_RE };
