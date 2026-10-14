// OTP email (HTML + plain text). Inline styles only - email clients ignore <style> blocks.
const escapeHtml = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

// purpose 'login' (default) or 'delete' (33.17 confirm account deletion)
const COPY = {
  login: {
    subject: (app) => `${app} login code`,
    intro: 'Here is your login code:',
    ignore: "If you didn't try to log in, you can safely ignore this email.",
  },
  delete: {
    subject: (app) => `Confirm deleting your ${app} account`,
    intro: 'Use this code to confirm that you want to delete your account:',
    ignore:
      "If you didn't ask to delete your account, ignore this email - nothing will be deleted - and log out on devices you don't recognise.",
  },
};

const otpEmail = ({ appName, otp, ttlMinutes, purpose = 'login' }) => {
  const app = escapeHtml(appName);
  const code = escapeHtml(otp);
  const copy = COPY[purpose] || COPY.login;

  const subject = `${copy.subject(appName)}: ${otp}`;

  const text = [
    `${copy.intro} ${otp}`,
    `It expires in ${ttlMinutes} minutes.`,
    '',
    `${copy.ignore} Never share this code with anyone.`,
  ].join('\n');

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#F4F6F5;font-family:Roboto,Arial,sans-serif;color:#1B2A2F;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F6F5;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#FFFFFF;border-radius:20px;padding:32px 28px;">
            <tr>
              <td align="center" style="padding-bottom:20px;">
                <div style="display:inline-block;width:56px;height:56px;line-height:56px;border-radius:16px;background:#22878F;color:#FFFFFF;font-size:26px;font-weight:700;">${app.charAt(0)}</div>
                <div style="margin-top:10px;font-size:18px;font-weight:700;color:#22878F;">${app}</div>
              </td>
            </tr>
            <tr>
              <td style="font-size:16px;line-height:24px;padding-bottom:16px;">
                ${escapeHtml(copy.intro)}
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:8px 0 20px;">
                <div style="display:inline-block;background:#F4F6F5;border-radius:16px;padding:16px 24px;font-size:34px;font-weight:700;letter-spacing:10px;color:#1B2A2F;">${code}</div>
              </td>
            </tr>
            <tr>
              <td style="font-size:14px;line-height:21px;color:#8A9496;">
                This code expires in <b>${ttlMinutes} minutes</b>. Never share it with anyone &mdash;
                ${app} will never ask you for it.<br><br>
                ${escapeHtml(copy.ignore)}
              </td>
            </tr>
          </table>
          <div style="font-size:12px;color:#8A9496;padding-top:16px;">&copy; ${app}</div>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { subject, text, html };
};

module.exports = { otpEmail };
