import type { Notification, IssueConfig, IssueMode } from '@issue-tracker/types';

const TELEGRAM_API = 'https://api.telegram.org';

// ─── Mode display helpers ──────────────────────────────────────────────────────

const MODE_EMOJI: Record<IssueMode, string> = {
  awaiting_reply: '🔴',
  inactivity_watch: '🟡',
  wip_watch: '🔵',
};

// ─── Message building ──────────────────────────────────────────────────────────

function buildInstantMessage(notif: Notification, config: IssueConfig): string {
  const emoji = MODE_EMOJI[notif.mode_at_time];
  const issueUrl = `https://github.com/${config.repo}/issues/${config.issue_number}`;
  const { actor, summary, detail } = notif.payload;

  return [
    `${emoji} <b>[${notif.mode_at_time}]</b> ${config.repo}#${config.issue_number}`,
    `<i>${escapeHtml(config.title)}</i>`,
    ``,
    `↳ ${escapeHtml(summary)}`,
    detail ? `↳ <code>${escapeHtml(detail.slice(0, 300))}</code>` : '',
    ``,
    `→ <a href="${issueUrl}">View issue</a>`,
  ]
    .filter((line) => line !== undefined)
    .join('\n');
}

function buildDigestMessage(
  notifications: Notification[],
  configMap: Map<string, IssueConfig>,
): string {
  // Group by issue_ref
  const byIssue = new Map<string, Notification[]>();
  for (const n of notifications) {
    if (!byIssue.has(n.issue_ref)) byIssue.set(n.issue_ref, []);
    byIssue.get(n.issue_ref)!.push(n);
  }

  const lines: string[] = [`📋 <b>Digest — ${notifications.length} update(s)</b>`, ''];

  for (const [ref, notifs] of byIssue) {
    const config = configMap.get(ref);
    const label = config ? `${config.repo}#${config.issue_number}` : ref;
    const emoji = MODE_EMOJI[notifs[0]!.mode_at_time] ?? '⚪';
    const summary = notifs.map((n) => n.payload.summary).join('; ');
    lines.push(`${emoji} <b>${label}</b> — ${escapeHtml(summary)}`);
  }

  return lines.join('\n');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ─── Telegram send ─────────────────────────────────────────────────────────────

async function sendMessage(
  text: string,
  token: string,
  chatId: string,
): Promise<number> {
  const url = `${TELEGRAM_API}/bot${token}/sendMessage`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });

  const body = (await response.json()) as { ok: boolean; result?: { message_id: number }; description?: string };

  if (!body.ok) {
    throw new Error(`Telegram API error: ${body.description ?? 'unknown'}`);
  }

  return body.result?.message_id ?? 0;
}

// ─── Public API ────────────────────────────────────────────────────────────────

export async function sendInstant(
  notif: Notification,
  config: IssueConfig,
  token: string,
  chatId: string,
): Promise<number> {
  const text = buildInstantMessage(notif, config);
  const messageId = await sendMessage(text, token, chatId);
  console.log(
    `  📨 Sent [${notif.type}] for ${notif.issue_ref} (msg_id: ${messageId})`,
  );
  return messageId;
}

export async function sendDigest(
  notifications: Notification[],
  configMap: Map<string, IssueConfig>,
  token: string,
  chatId: string,
): Promise<number> {
  if (notifications.length === 0) return 0;
  const text = buildDigestMessage(notifications, configMap);
  const messageId = await sendMessage(text, token, chatId);
  console.log(`  📋 Sent digest with ${notifications.length} update(s) (msg_id: ${messageId})`);
  return messageId;
}
