// Receipt emails: an agreement/advance receipt at checkout, and a final
// receipt (with any early-return recalculation) when the gear comes back.
//
// Sending goes through Resend. With no RESEND_API_KEY configured the receipt is
// written to RECEIPT_LOG_DIR instead of sent, so the whole flow stays testable
// before credentials exist.

const fs = require('fs');
const path = require('path');

const BRAND = '#e34b3f';
const INK = '#1a1a1a';
const MUTED = '#6b7280';
const LINE = '#e5e7eb';

const money = value => 'LKR ' + Number(value || 0).toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const when = value => new Date(value).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Outer shell shared by both receipts. Table-based and inline-styled because
// email clients strip <style> blocks and ignore flex/grid.
function layout({ heading, tagline, body, footerNote }) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(heading)}</title></head>
<body style="margin:0;padding:0;background:#f4f4f6;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f6;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.06);">
  <tr><td style="background:${INK};padding:26px 32px;">
    <div style="font-size:21px;font-weight:700;color:#ffffff;letter-spacing:.3px;">Rent<span style="color:${BRAND};">Master</span></div>
    <div style="font-size:11px;color:#9ca3af;letter-spacing:2px;text-transform:uppercase;margin-top:3px;">Studio Equipment Rental</div>
  </td></tr>
  <tr><td style="padding:30px 32px 6px;">
    <h1 style="margin:0;font-size:20px;color:${INK};font-weight:700;">${esc(heading)}</h1>
    <p style="margin:7px 0 0;font-size:14px;color:${MUTED};line-height:1.5;">${tagline}</p>
  </td></tr>
  <tr><td style="padding:22px 32px 30px;">${body}</td></tr>
  <tr><td style="background:#fafafa;border-top:1px solid ${LINE};padding:20px 32px;">
    <p style="margin:0;font-size:12px;color:${MUTED};line-height:1.6;">${footerNote}</p>
    <p style="margin:10px 0 0;font-size:11px;color:#9ca3af;">This receipt was generated automatically by RentMaster.</p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

function panel(title, rows) {
  const cells = rows.filter(Boolean).map(([label, value]) => `
      <tr>
        <td style="padding:5px 0;font-size:13px;color:${MUTED};">${esc(label)}</td>
        <td style="padding:5px 0;font-size:13px;color:${INK};text-align:right;font-weight:600;">${esc(value)}</td>
      </tr>`).join('');
  return `
  <div style="font-size:11px;letter-spacing:1.4px;text-transform:uppercase;color:${MUTED};font-weight:700;margin:0 0 8px;">${esc(title)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 22px;">${cells}</table>`;
}

// Charge lines, with the final row emphasised.
function ledger(rows) {
  const body = rows.filter(Boolean).map(([label, value, style]) => {
    const strong = style === 'total';
    const accent = style === 'refund' ? '#059669' : style === 'due' ? '#b45309' : INK;
    return `
      <tr>
        <td style="padding:9px 0;border-top:1px solid ${LINE};font-size:${strong ? '14' : '13'}px;color:${strong ? INK : MUTED};font-weight:${strong ? '700' : '400'};">${esc(label)}</td>
        <td style="padding:9px 0;border-top:1px solid ${LINE};font-size:${strong ? '15' : '13'}px;text-align:right;color:${strong ? INK : accent};font-weight:${strong || style ? '700' : '600'};">${esc(value)}</td>
      </tr>`;
  }).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">${body}</table>`;
}

function callout(text, tone) {
  const bg = tone === 'good' ? '#ecfdf5' : '#fff7ed';
  const bar = tone === 'good' ? '#059669' : '#f59e0b';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 22px;"><tr>
    <td style="background:${bg};border-left:4px solid ${bar};border-radius:6px;padding:13px 16px;font-size:13px;color:${INK};line-height:1.6;">${text}</td>
  </tr></table>`;
}

const METHOD_LABELS = { cash: 'Cash', bank_transfer: 'Bank transfer', online: 'Online payment' };

// ---------------------------------------------------------------- templates

function checkoutReceipt(d) {
  const balance = Math.max(0, Number(d.totalFee) - Number(d.advance));
  const body = [
    panel('Client', [
      ['Name', d.customerName],
      ['NIC', d.nic],
      d.phone ? ['Phone', d.phone] : null
    ]),
    panel('Equipment & period', [
      ['Item', `${d.equipmentName} (${d.equipmentType})`],
      ['Pickup', when(d.startDate)],
      ['Due back', when(d.endDate)],
      ['Booked days', String(d.bookedDays)],
      ['Daily rate', money(d.dailyPrice)]
    ]),
    ledger([
      [`Rental charge (${d.bookedDays} ${d.bookedDays === 1 ? 'day' : 'days'} x ${money(d.dailyPrice)})`, money(d.totalFee)],
      [`Advance paid (${METHOD_LABELS[d.method] || d.method}${d.reference ? ' - ' + d.reference : ''})`, '- ' + money(d.advance)],
      ['Balance due on return', money(balance), balance > 0 ? 'due' : null],
      ['Refundable deposit held', money(d.deposit)]
    ]),
    callout(`The deposit of <strong>${money(d.deposit)}</strong> is fully refundable when the equipment is returned in good condition. If you return early, the rental charge is recalculated for the days actually used.`)
  ].join('');

  return {
    subject: `Rental agreement & advance receipt - ${d.equipmentName} (#${String(d.rentalId).padStart(5, '0')})`,
    html: layout({
      heading: 'Rental agreement & advance receipt',
      tagline: `Receipt <strong>#${esc(String(d.rentalId).padStart(5, '0'))}</strong> &middot; issued ${esc(when(new Date()))}`,
      body,
      footerNote: `Please bring this receipt when returning the equipment. Questions? Just reply to this email.`
    })
  };
}

function finalReceipt(d) {
  const early = Number(d.actualDays) < Number(d.bookedDays);
  const depositRefund = Math.max(0, Number(d.deposit) - Number(d.deduction));
  const stillDue = Math.max(0, Number(d.finalTotal) - Number(d.advance) - Number(d.collected));
  const lines = [
    [`Original booking (${d.bookedDays} ${d.bookedDays === 1 ? 'day' : 'days'})`, money(d.originalTotal)],
    early ? [`Recalculated for ${d.actualDays} ${d.actualDays === 1 ? 'day' : 'days'} actually used`, money(d.finalTotal), 'total'] : null,
    !early ? ['Rental charge', money(d.finalTotal), 'total'] : null,
    ['Advance already paid', '- ' + money(d.advance)],
    Number(d.collected) > 0 ? ['Balance collected on return', '- ' + money(d.collected)] : null,
    Number(d.refund) > 0 ? ['Overpayment refunded to you', money(d.refund), 'refund'] : null,
    stillDue > 0 ? ['Balance still outstanding', money(stillDue), 'due'] : null,
    ['Deposit held', money(d.deposit)],
    Number(d.deduction) > 0 ? [`Deposit deduction - ${d.deductionReason || 'adjustment'}`, '- ' + money(d.deduction), 'due'] : null,
    ['Deposit refunded', money(depositRefund), 'refund']
  ];

  const totalBack = Number(d.refund) + depositRefund;
  const body = [
    early
      ? callout(`You returned <strong>${d.bookedDays - d.actualDays} ${d.bookedDays - d.actualDays === 1 ? 'day' : 'days'} early</strong>, so we recharged only the ${d.actualDays} ${d.actualDays === 1 ? 'day' : 'days'} you actually used.`, 'good')
      : '',
    panel('Rental summary', [
      ['Item', `${d.equipmentName} (${d.equipmentType})`],
      ['Picked up', when(d.startDate)],
      ['Due back', when(d.endDate)],
      ['Returned', when(d.actualReturn)],
      ['Days booked / used', `${d.bookedDays} / ${d.actualDays}`],
      ['Daily rate', money(d.dailyPrice)]
    ]),
    ledger(lines),
    stillDue > 0 ? callout(`A balance of <strong>${money(stillDue)}</strong> remains outstanding on this rental. Please settle it at your earliest convenience.`) : '',
    totalBack > 0
      ? callout(`<strong>${money(totalBack)}</strong> is being returned to you${Number(d.refund) > 0 ? ' (overpayment + deposit)' : ' (deposit)'}.`, 'good')
      : '',
    `<p style="margin:4px 0 0;font-size:14px;color:${INK};line-height:1.65;">Thank you for renting with RentMaster, ${esc(d.customerName.split(' ')[0])}. It was a pleasure doing business with you, and we hope the gear served you well. We would love to see you again on your next shoot.</p>`
  ].join('');

  return {
    subject: `Final receipt - thank you! ${d.equipmentName} (#${String(d.rentalId).padStart(5, '0')})`,
    html: layout({
      heading: 'Final receipt',
      tagline: `Receipt <strong>#${esc(String(d.rentalId).padStart(5, '0'))}</strong> &middot; closed ${esc(when(d.actualReturn))}`,
      body,
      footerNote: 'This rental is now closed and the equipment is checked back in. Thank you for choosing RentMaster.'
    })
  };
}

// ------------------------------------------------------------------ sending

async function deliver({ to, subject, html }) {
  if (!to) return { sent: false, reason: 'no-email' };
  const key = process.env.RESEND_API_KEY;
  const from = process.env.RECEIPT_FROM || 'RentMaster <onboarding@resend.dev>';

  if (!key) {
    // No credentials yet: keep the artefact so the flow is still verifiable.
    const dir = process.env.RECEIPT_LOG_DIR;
    if (dir) {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${Date.now()}-${String(to).replace(/[^a-z0-9]/gi, '_')}.html`);
      fs.writeFileSync(file, html);
      return { sent: false, reason: 'no-api-key', file, subject };
    }
    return { sent: false, reason: 'no-api-key', subject };
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, html })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Resend ${response.status}: ${JSON.stringify(payload)}`);
  return { sent: true, id: payload.id, subject };
}

// A failed receipt must never fail the rental it describes.
async function send(kind, data) {
  try {
    const built = kind === 'checkout' ? checkoutReceipt(data) : finalReceipt(data);
    const result = await deliver({ to: data.email, subject: built.subject, html: built.html });
    if (result.sent) console.log(`[receipt] ${kind} sent to ${data.email} (${result.id})`);
    else console.log(`[receipt] ${kind} not sent (${result.reason})${result.file ? ' -> ' + result.file : ''}`);
    return result;
  } catch (error) {
    console.error(`[receipt] ${kind} failed:`, error.message);
    return { sent: false, reason: 'error', error: error.message };
  }
}

module.exports = { send, checkoutReceipt, finalReceipt, money, METHOD_LABELS };
