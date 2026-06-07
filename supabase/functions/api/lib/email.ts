export interface SendInviteEmailParams {
  to: string;
  inviterName: string;
  token: string;
  personalNote?: string | null;
  expiresAt: string;
}

export async function sendInviteEmail(params: SendInviteEmailParams): Promise<void> {
  const { to, inviterName, token, personalNote, expiresAt } = params;

  const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
  if (!RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is not set');
  }

  const appUrl = Deno.env.get('APP_URL') ?? 'https://www.duallin.com';
  const inviteUrl = `${appUrl}/invite?token=${encodeURIComponent(token)}`;

  const expiryDate = new Date(expiresAt).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric',
  });
  const expiryDateHe = new Date(expiresAt).toLocaleDateString('he-IL', {
    day: 'numeric', month: 'long', year: 'numeric',
  });

  const personalNoteBlock = personalNote
    ? `
      <tr>
        <td style="padding: 0 32px 24px 32px;">
          <div style="border-left: 3px solid #762277; padding: 12px 16px; background-color: #f3eaf5; border-radius: 0 8px 8px 0;">
            <p style="margin: 0 0 4px 0; font-size: 11px; font-weight: 700; color: #762277; text-transform: uppercase; letter-spacing: 0.6px;">Personal Note</p>
            <p style="margin: 0; font-size: 14px; color: #333333; line-height: 1.6; font-style: italic;">"${personalNote}"</p>
          </div>
        </td>
      </tr>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="en" dir="ltr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>You've been personally invited to Duallin</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f7f0fa; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f7f0fa;">
    <tr>
      <td align="center" style="padding: 32px 16px;">
        <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px; width: 100%; border-radius: 16px; overflow: hidden; box-shadow: 0 8px 32px rgba(59,10,71,0.15);">

          <!-- HEADER -->
          <tr>
            <td style="background: linear-gradient(135deg, #380a47 0%, #762277 60%, #754389 100%); padding: 36px 32px 28px 32px; text-align: center;">
              <!-- Logo white badge -->
              <div style="display: inline-block; background-color: #ffffff; border-radius: 12px; padding: 10px 20px; margin-bottom: 18px;">
                <img src="https://www.duallin.com/assets/logotext-Dt264Rdr.png" alt="Duallin" width="180" style="display: block; height: auto;" />
              </div>
              <p style="margin: 0 0 6px 0; font-size: 22px; font-weight: 800; color: #ffffff; letter-spacing: -0.3px;">Do all in. Together.</p>
              <p style="margin: 0; font-size: 13px; color: rgba(255,255,255,0.75); font-weight: 400;">The professional network built exclusively for Haredi women in tech</p>
              <p style="margin: 4px 0 0 0; font-size: 13px; color: rgba(255,255,255,0.75); font-weight: 400;" dir="rtl">הרשת המקצועית שנבנתה במיוחד לנשים חרדיות בהייטק</p>
            </td>
          </tr>

          <!-- ACCENT STRIP -->
          <tr>
            <td style="height: 3px; background: linear-gradient(90deg, #380a47, #c084fc, #380a47); padding: 0;"></td>
          </tr>

          <!-- PILL TAG -->
          <tr>
            <td style="background-color: #ffffff; padding: 24px 32px 0 32px; text-align: center;">
              <span style="display: inline-block; background: linear-gradient(90deg, #762277, #a855f7); color: #ffffff; font-size: 11px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; padding: 6px 18px; border-radius: 100px;">
                ✦ Personal Invitation &nbsp;·&nbsp; הזמנה אישית ✦
              </span>
            </td>
          </tr>

          <!-- BILINGUAL INVITATION CARDS -->
          <tr>
            <td style="background-color: #ffffff; padding: 20px 32px 0 32px;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <!-- EN card -->
                  <td width="48%" valign="top" style="background-color: #faf5ff; border: 1px solid #e9d5ff; border-radius: 10px; padding: 16px 14px;">
                    <p style="margin: 0 0 6px 0; font-size: 13px; font-weight: 700; color: #380a47;">You've been personally invited</p>
                    <p style="margin: 0; font-size: 13px; color: #555555; line-height: 1.5;">
                      <strong style="color: #762277;">${inviterName}</strong> thinks you'd be a great fit for the Duallin community and personally invites you to join.
                    </p>
                  </td>
                  <td width="4%"></td>
                  <!-- HE card -->
                  <td width="48%" valign="top" dir="rtl" style="background-color: #faf5ff; border: 1px solid #e9d5ff; border-radius: 10px; padding: 16px 14px; text-align: right;">
                    <p style="margin: 0 0 6px 0; font-size: 13px; font-weight: 700; color: #380a47;">הוזמנת אישית לדואולין</p>
                    <p style="margin: 0; font-size: 13px; color: #555555; line-height: 1.5;">
                      <strong style="color: #762277;">${inviterName}</strong> חושבת שאת תשתלבי נהדר בקהילת דואולין ומזמינה אותך להצטרף באופן אישי.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- PERSONAL NOTE (conditional) -->
          ${personalNoteBlock}

          <!-- PLATFORM DESCRIPTION -->
          <tr>
            <td style="background-color: #ffffff; padding: 24px 32px 0 32px;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f9f2ff; border: 1px solid #e9d5ff; border-radius: 10px; overflow: hidden;">
                <tr>
                  <td style="padding: 6px 16px; background: linear-gradient(90deg, #762277, #a855f7);">
                    <p style="margin: 0; font-size: 10px; font-weight: 800; color: #ffffff; text-transform: uppercase; letter-spacing: 1px;">About Duallin &nbsp;·&nbsp; אודות דואולין</p>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 16px;">
                    <table width="100%" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <!-- EN description -->
                        <td width="48%" valign="top" style="font-size: 13px; color: #444444; line-height: 1.65;">
                          Built exclusively for Haredi women in tech - real professional networking, a growing community that understands your world, meaningful career opportunities, daily job listings,
                          <br /><br />
                          and honest company insights from women who've actually been there. Not a chat group, not a mailing list - a permanent professional presence, built to last. The place where our community and the tech industry finally meet.
                        </td>
                        <td width="4%"></td>
                        <!-- HE description -->
                        <td width="48%" valign="top" dir="rtl" style="font-size: 13px; color: #444444; line-height: 1.65; text-align: right;">
                          נבנתה במיוחד לנשים חרדיות בהייטק - נטוורקינג מקצועי אמיתי, קהילה שמבינה את עולמך, הזדמנויות קריירה, משרות מדי יום,
                          <br /><br />
                          ומידע אמיתי על חברות מנשים שהיו שם. לא קבוצת צ&#39;אט ולא רשימת תפוצה - נוכחות מקצועית קבועה שבנויה להישאר. המקום שבו הקהילה שלנו ותעשיית ההייטק סוף סוף נפגשות.
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- CTA BUTTON -->
          <tr>
            <td style="background-color: #ffffff; padding: 28px 32px 8px 32px; text-align: center;">
              <a href="${inviteUrl}" style="display: inline-block; background: linear-gradient(135deg, #380a47 0%, #762277 100%); color: #ffffff; font-size: 15px; font-weight: 700; text-decoration: none; padding: 14px 40px; border-radius: 50px; letter-spacing: 0.3px; box-shadow: 0 4px 14px rgba(118,34,119,0.4);">
                Join Duallin &nbsp;|&nbsp; הצטרפי לדואולין
              </a>
            </td>
          </tr>

          <!-- EXPIRY -->
          <tr>
            <td style="background-color: #ffffff; padding: 16px 32px 28px 32px; text-align: center;">
              <p style="margin: 0; font-size: 12px; color: #888888;">
                &#x23F3; This invitation expires on <strong>${expiryDate}</strong>
              </p>
              <p style="margin: 4px 0 0 0; font-size: 12px; color: #888888;" dir="rtl">
                &#x23F3; הזמנה זו פגה ב-<strong>${expiryDateHe}</strong>
              </p>
            </td>
          </tr>

          <!-- FOOTER -->
          <tr>
            <td style="background: linear-gradient(135deg, #380a47 0%, #4b154c 100%); padding: 20px 32px; text-align: center;">
              <p style="margin: 0 0 4px 0; font-size: 12px; color: rgba(255,255,255,0.7);">Questions? Contact us at</p>
              <a href="mailto:contact@duallin.com" style="font-size: 13px; color: #c084fc; text-decoration: none; font-weight: 600;">contact@duallin.com</a>
              <p style="margin: 10px 0 0 0; font-size: 11px; color: rgba(255,255,255,0.4);">&copy; ${new Date().getFullYear()} Duallin. All rights reserved.</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Duallin <invites@duallin.com>',
      to: [to],
      subject: "You've been personally invited to Duallin | הוזמנת אישית לדואולין",
      html,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Resend API error ${response.status}: ${body}`);
  }
}
