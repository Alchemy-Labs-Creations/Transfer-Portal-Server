// Email notices, sent by the signaling server itself (plain SMTP over TLS - no extra packages).
// Settings come from /etc/transfer-portal-signal.env: SMTP_USER + SMTP_PASS (a Gmail app password), and optionally
// SMTP_HOST / SMTP_PORT (default smtp.gmail.com:465) and MAIL_FROM_NAME (default "Transfer Portal").
// The email never carries the message itself - only who wrote and that something is waiting.
// Test from the command line:  node mailer.js --test you@example.com   (with the same environment loaded)
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CFG = {
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: Number(process.env.SMTP_PORT) || 465,
  user: process.env.SMTP_USER || '',
  pass: (process.env.SMTP_PASS || '').replace(/\s+/g, ''),
  name: (process.env.MAIL_FROM_NAME || 'Transfer Portal').replace(/[\r\n"<>]/g, '').slice(0, 60),
};
const enabled = () => !!(CFG.user && CFG.pass);
let LOGO = null;
try { LOGO = fs.readFileSync(path.join(__dirname, 'mail-logo.png')); } catch { /* sent without the logo */ }

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const oneLine = (s) => String(s).replace(/[\r\n]+/g, ' ').trim();
// a header value that may hold any characters (names are typed by people)
const word = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);
const b64 = (buf) => Buffer.from(buf).toString('base64').replace(/.{76}/g, '$&\r\n');

// { heading, lines: [..], kind: 'chat' | 'files' } -> the text and HTML versions
function render({ heading, lines, kind }) {
  const note = 'This is an automatic notice from Transfer Portal. It never includes your messages, and it will never ask you to sign in, pay, or open a link.';
  const why = 'You get these because you turned on email notices in Transfer Portal (Settings, "Notifications when you\'re away"). To stop them, clear your email address there. At most one email an hour.';
  const text = [heading, '', ...lines, '', '--', note, why].join('\r\n');
  const icon = kind === 'files' ? '&#128230;' : '&#9993;&#65039;';
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>${esc(heading)}</title></head>
<body style="margin:0;padding:0;background:#eef2f7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef2f7;padding:28px 12px;font-family:Segoe UI,Helvetica,Arial,sans-serif;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #dbe3ee;">
  <tr><td style="background:#06101f;padding:18px 24px;">
    <table role="presentation" cellpadding="0" cellspacing="0"><tr>
      ${LOGO ? '<td style="padding-right:12px;"><img src="cid:tplogo" width="40" height="40" alt="" style="display:block;border:0;"></td>' : ''}
      <td style="font-size:18px;font-weight:600;color:#e8f3ff;letter-spacing:.3px;">Transfer Portal</td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:26px 24px 8px;">
    <div style="font-size:13px;color:#5b6b80;margin-bottom:6px;">${icon}&nbsp; Waiting for you</div>
    <div style="font-size:21px;font-weight:600;color:#0d1b2e;line-height:1.3;">${esc(heading)}</div>
  </td></tr>
  <tr><td style="padding:6px 24px 22px;font-size:15px;line-height:1.55;color:#243447;">
    ${lines.map((l) => `<p style="margin:0 0 10px;">${esc(l)}</p>`).join('')}
  </td></tr>
  <tr><td style="padding:0 24px 22px;">
    <div style="background:#f3f7fc;border:1px solid #dbe3ee;border-radius:10px;padding:12px 14px;font-size:13px;line-height:1.5;color:#3d4f66;">&#128274;&nbsp; ${esc(note)}</div>
  </td></tr>
  <tr><td style="padding:14px 24px 20px;border-top:1px solid #e6ecf3;font-size:12px;line-height:1.5;color:#7a8799;">${esc(why)}<br>Transfer Portal &middot; Alchemy Labs Creations</td></tr>
</table>
</td></tr></table>
</body></html>`;
  return { text, html };
}

function build(to, subject, body) {
  const alt = 'alt' + crypto.randomBytes(8).toString('hex'), rel = 'rel' + crypto.randomBytes(8).toString('hex');
  const domain = CFG.user.split('@')[1] || 'localhost';
  const head = [
    `From: "${CFG.name}" <${CFG.user}>`,
    `To: <${to}>`,
    `Subject: ${word(oneLine(subject))}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${crypto.randomBytes(12).toString('hex')}@${domain}>`,
    'Auto-Submitted: auto-generated',
    'MIME-Version: 1.0',
  ];
  const altPart = [
    `--${alt}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(body.text),
    `--${alt}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(body.html),
    `--${alt}--`,
  ];
  if (!LOGO) return [...head, `Content-Type: multipart/alternative; boundary="${alt}"`, '', ...altPart, ''].join('\r\n');
  return [...head, `Content-Type: multipart/related; boundary="${rel}"`, '',
    `--${rel}`, `Content-Type: multipart/alternative; boundary="${alt}"`, '', ...altPart,
    `--${rel}`, 'Content-Type: image/png', 'Content-Transfer-Encoding: base64', 'Content-ID: <tplogo>', 'Content-Disposition: inline; filename="transfer-portal.png"', '', b64(LOGO),
    `--${rel}--`, ''].join('\r\n');
}

// a small SMTP conversation over TLS (port 465): EHLO, AUTH PLAIN, MAIL, RCPT, DATA, QUIT
function smtp(to, data) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host: CFG.host, port: CFG.port, servername: CFG.host });
    let buf = '', step = 0;
    const steps = [
      [220, () => `EHLO ${require('os').hostname().replace(/[^A-Za-z0-9.-]/g, '') || 'localhost'}`],
      [250, () => `AUTH PLAIN ${Buffer.from(`\0${CFG.user}\0${CFG.pass}`).toString('base64')}`],
      [235, () => `MAIL FROM:<${CFG.user}>`],
      [250, () => `RCPT TO:<${to}>`],
      [250, () => 'DATA'],
      [354, () => data.replace(/^\./gm, '..') + '\r\n.'],
      [250, () => 'QUIT'],
    ];
    const fail = (e) => { sock.destroy(); reject(e); };
    sock.setTimeout(20000, () => fail(new Error('the email server stopped answering')));
    sock.on('error', fail);
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      let m;
      while ((m = buf.match(/^(\d{3})([ -])(.*)\r?\n/m)) && buf.indexOf(m[0]) === 0) {
        buf = buf.slice(m[0].length);
        if (m[2] === '-') continue; // more lines of the same reply
        const code = Number(m[1]);
        if (step >= steps.length) { sock.end(); return resolve(); }
        if (code !== steps[step][0]) return fail(new Error(code === 535 ? 'the email login was refused (check the app password)' : `the email server said ${code} ${m[3]}`));
        sock.write(steps[step][1]() + '\r\n');
        step++;
      }
    });
    sock.on('end', () => { if (step >= steps.length) resolve(); });
  });
}

async function sendMail(to, subject, content) {
  if (!enabled()) throw new Error('email is not set up on this server');
  if (!/^[^\s@<>()",;:]{1,64}@[^\s@<>()",;:]{1,190}\.[A-Za-z]{2,24}$/.test(to)) throw new Error('not an email address');
  await smtp(to, build(to, subject, render(content)));
}

module.exports = { enabled, sendMail };

if (require.main === module && process.argv[2] === '--test') {
  const to = process.argv[3];
  sendMail(to, 'Email notices are working', { heading: 'Email notices are working', kind: 'chat', lines: ['This is a test from your Transfer Portal server.', 'When a linked PC sends you a message or files while yours is off, you\'ll get a short email like this one.'] })
    .then(() => { console.log(`Test email sent to ${to} (check spam the first time).`); })
    .catch((e) => { console.log(`The test email failed: ${e.message || e.code || e}`); process.exitCode = 1; });
}
