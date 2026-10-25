import globalStyles from '../styles/global.css?raw';
import { serverConfig } from '../config/server';

// 邮件内联样式从全站设计变量读取，两个通知共用一张信纸。
const designValue = (name: string) => {
  const value = globalStyles.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1].trim();
  if (!value || (name !== 'playful' && !/^#[\da-f]{6}$/i.test(value))) throw new Error(`Invalid email design token: ${name}`);
  return value.replaceAll('"', "'");
};
const palette = {
  canvas: designValue('mail-canvas'), paper: designValue('mail-paper'), surface: designValue('mail-surface'),
  text: designValue('mail-text'), muted: designValue('mail-muted'), blue: designValue('mail-blue'), pink: designValue('mail-pink'),
  glowBlue: designValue('mail-glow-blue'), font: designValue('playful'),
};
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const textHtml = (value: string) => escapeHtml(value).replace(/\r\n?|\n/g, '<br>');
type EmailKind = 'reply' | 'admin';

function publicAddress(value: string) {
  const address = new URL(value);
  if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password) throw new Error('Invalid reply email address');
  return address;
}

// 三括号变量只接收本模块生成的安全 HTML；纯文本使用独立变量。
export function createResendTemplate(kind: EmailKind, origin: string) {
  const base = publicAddress(origin).origin;
  const asset = (name: string) => escapeHtml(new URL(`/media/branding/${name}`, base).href);
  const subject = kind === 'reply' ? 'SamsBlog · 你的评论收到了新的回复~' : 'SamsBlog · {{{EVENT_TEXT}}}';
  const heading = kind === 'reply' ? '你的评论收到了新的回复~' : '{{{EVENT_HTML}}}';
  const original = kind === 'reply' ? `<tr><td class="mail-padding" style="padding:0 28px 22px;word-break:break-word;overflow-wrap:anywhere;"><p style="margin:0 0 10px;font-size:14px;line-height:1.8;color:${palette.muted};">你此前在SamsBlog的留言</p><div style="font-size:16px;line-height:1.9;color:${palette.muted};">{{{ORIGINAL_HTML}}}</div></td></tr>` : '';
  const optOut = kind === 'reply' ? `<p style="margin:14px 0 0;font-size:12px;line-height:1.8;"><a href="{{{OPT_OUT_HTML}}}" style="display:inline-block;padding:8px 0;color:${palette.muted};text-decoration:underline;">不再接收此留言的回复通知</a></p>` : '';
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${subject}</title>
<style>@media screen and (max-width:480px){.mail-padding{padding-left:20px!important;padding-right:20px!important}.mail-title{font-size:24px!important}.mail-reply{padding:18px!important}}</style></head>
<body style="margin:0;padding:0;background-color:${palette.canvas};color:${palette.text};font-family:${palette.font};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">{{{PREHEADER_HTML}}}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${palette.canvas}"><tr><td align="center" style="padding:24px 12px;">
<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="${palette.paper}" background="${asset('mail-stationery.jpg')}" style="width:100%;max-width:600px;table-layout:fixed;border-radius:28px;background-image:url('${asset('mail-stationery.jpg')}');background-position:center top;background-repeat:no-repeat;background-size:600px auto;">
<tr><td class="mail-padding" style="padding:28px 28px 22px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="table-layout:fixed;"><tr><td width="62%"><a href="${escapeHtml(base)}"><img src="${asset('mail-brand.png')}" width="176" height="66" alt="SamsBlog" style="display:block;width:176px;max-width:100%;height:auto;border:0;"></a></td><td align="right" style="font-size:13px;"><a href="https://moesam.com" style="color:${palette.blue};text-decoration:none;">moesam.com</a></td></tr></table>
<h1 class="mail-title" style="margin:24px 0 16px;font-weight:600;font-size:28px;line-height:1.55;color:${palette.text};">${heading}</h1>
<p style="margin:0;font-size:16px;line-height:1.9;word-break:break-word;overflow-wrap:anywhere;">{{{GREETING_HTML}}}</p>
<p style="margin:6px 0 0;font-size:14px;line-height:1.9;color:${palette.muted};word-break:break-word;overflow-wrap:anywhere;">{{{CONTEXT_HTML}}}</p>
</td></tr>${original}
<tr><td class="mail-padding" style="padding:0 28px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${palette.surface}" style="width:100%;table-layout:fixed;border-radius:18px;"><tr><td class="mail-reply" style="padding:22px 24px;word-break:break-word;overflow-wrap:anywhere;">
<div style="margin:0 0 14px;font-size:16px;line-height:2;font-weight:600;color:${palette.blue};">{{{AUTHOR_HTML}}}</div>
<div style="font-size:17px;line-height:1.95;color:${palette.text};">{{{CONTENT_HTML}}}</div>
</td></tr></table></td></tr>
<tr><td class="mail-padding" style="padding:24px 28px 28px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" bgcolor="${palette.glowBlue}" style="border-radius:24px;"><a href="{{{ACTION_HTML}}}" style="display:inline-block;padding:12px 26px;border-radius:24px;font-size:16px;line-height:1.5;font-weight:600;color:${palette.blue};text-decoration:none;">${kind === 'reply' ? '查看并回复' : '前往后台处理'} &nbsp;↗</a></td></tr></table>
<p style="margin:26px 0 6px;font-size:13px;line-height:1.8;color:${palette.muted};">此邮件自动分发，请勿回复此邮件</p>
<p style="margin:0;font-size:14px;line-height:1.8;color:${palette.pink};">只是一只大黄狗</p>${optOut}
</td></tr></table><!--[if mso]></td></tr></table><![endif]--></td></tr></table></body></html>`;
  const text = kind === 'reply'
    ? '你的评论收到了新的回复~\n\n{{{GREETING_TEXT}}}\n{{{CONTEXT_TEXT}}}\n\n你此前在SamsBlog的留言\n{{{ORIGINAL_TEXT}}}\n\n{{{AUTHOR_TEXT}}}\n{{{CONTENT_TEXT}}}\n\n查看并回复：{{{ACTION_TEXT}}}\n停止接收此留言的回复通知：{{{OPT_OUT_TEXT}}}\n\n此邮件自动分发，请勿回复此邮件\n只是一只大黄狗\nhttps://moesam.com'
    : '{{{EVENT_TEXT}}}\n\n{{{GREETING_TEXT}}}\n{{{CONTEXT_TEXT}}}\n\n{{{AUTHOR_TEXT}}}\n{{{CONTENT_TEXT}}}\n\n前往后台处理：{{{ACTION_TEXT}}}\n\n此邮件自动分发，请勿回复此邮件\n只是一只大黄狗\nhttps://moesam.com';
  const keys = [...new Set([...`${html}${text}${subject}`.matchAll(/\{\{\{([A-Z_]+)\}\}\}/g)].map((match) => match[1]))];
  return { name: `SamsBlog · ${kind === 'reply' ? '评论回复' : '站长提醒'} · 浅色星空`, alias: `samsblog-${kind}-v1`, subject, html, text, variables: keys.map((key) => ({ key, type: 'string' as const })) };
}

function renderEmail(kind: EmailKind, origin: string, variables: Record<string, string>, templateId?: string) {
  const template = createResendTemplate(kind, origin);
  const interpolate = (value: string) => value.replace(/\{\{\{([A-Z_]+)\}\}\}/g, (_, key: string) => {
    if (!(key in variables)) throw new Error(`Missing email variable: ${key}`);
    return variables[key];
  });
  const subject = interpolate(template.subject);
  if (templateId && Object.values(variables).every((value) => value.length <= serverConfig.notificationTemplateVariableMaxLength)) {
    return { subject, template: { id: templateId, variables } };
  }
  return { subject, text: interpolate(template.text), html: interpolate(template.html) };
}

export interface ReplyEmailInput {
  nickname: string; replyNickname: string; contextTitle: string; originalContent: string; content: string;
  address: string; unsubscribe: string; isOwnerReply?: boolean;
}

export function createReplyEmail(input: ReplyEmailInput, templateId?: string) {
  const address = publicAddress(input.address);
  if (publicAddress(input.unsubscribe).origin !== address.origin) throw new Error('Invalid reply email address');
  const author = input.isOwnerReply ? 'SuperSam' : input.replyNickname;
  const authorText = `${author}回复了你`;
  const authorHtml = input.isOwnerReply
    ? `<img src="${escapeHtml(new URL('/media/branding/mail-signature.png', address.origin).href)}" width="120" height="30" alt="SuperSam" style="display:inline-block;width:120px;height:30px;vertical-align:middle;border:0;"> 回复了你`
    : `${escapeHtml(author)}回复了你`;
  return renderEmail('reply', address.origin, {
    PREHEADER_HTML: `${escapeHtml(authorText)}，来自「${escapeHtml(input.contextTitle)}」。`,
    GREETING_HTML: `${escapeHtml(input.nickname)}，你好！`, GREETING_TEXT: `${input.nickname}，你好！`,
    CONTEXT_HTML: `来自「${escapeHtml(input.contextTitle)}」`, CONTEXT_TEXT: `来自「${input.contextTitle}」`,
    ORIGINAL_HTML: textHtml(input.originalContent), ORIGINAL_TEXT: input.originalContent,
    AUTHOR_HTML: authorHtml, AUTHOR_TEXT: authorText, CONTENT_HTML: textHtml(input.content), CONTENT_TEXT: input.content,
    ACTION_HTML: escapeHtml(input.address), ACTION_TEXT: input.address, OPT_OUT_HTML: escapeHtml(input.unsubscribe), OPT_OUT_TEXT: input.unsubscribe,
  }, templateId);
}

export function createAdminEmail(input: { event: string; name: string; context: string; content: string; address: string }, templateId?: string) {
  const address = publicAddress(input.address);
  return renderEmail('admin', address.origin, {
    EVENT_HTML: escapeHtml(input.event), EVENT_TEXT: input.event, PREHEADER_HTML: `${escapeHtml(input.event)} · ${escapeHtml(input.name)}`,
    GREETING_HTML: 'SuperSam，你好！', GREETING_TEXT: 'SuperSam，你好！', CONTEXT_HTML: escapeHtml(input.context), CONTEXT_TEXT: input.context,
    AUTHOR_HTML: escapeHtml(input.name), AUTHOR_TEXT: input.name, CONTENT_HTML: textHtml(input.content), CONTENT_TEXT: input.content,
    ACTION_HTML: escapeHtml(input.address), ACTION_TEXT: input.address,
  }, templateId);
}
