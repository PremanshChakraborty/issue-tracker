import { randomUUID } from 'crypto';
import type {
  IssueConfig,
  IssueState,
  Notification,
  GlobalSettings,
  NotificationType,
} from '@issue-tracker/types';
import type { GHComment, GHEvent, AuthorAssociation } from './githubClient';

// ─── Constants ─────────────────────────────────────────────────────────────────

const MAINTAINER_ASSOCIATIONS: AuthorAssociation[] = ['OWNER', 'MEMBER', 'COLLABORATOR'];

const KNOWN_BOTS = new Set([
  'dependabot[bot]',
  'github-actions[bot]',
  'codecov[bot]',
  'renovate[bot]',
  'stale[bot]',
  'allcontributors[bot]',
  'greenkeeper[bot]',
  'semantic-release-bot',
  'coderabbitai[bot]',
  'geptile[bot]',
  'sweep-ai[bot]',
]);

const SPIKE_COMMENT_THRESHOLD = 3; // ≥3 comments in one window
const SPIKE_SILENCE_DAYS = 7;      // after ≥7 days of silence

// ─── Helpers ───────────────────────────────────────────────────────────────────

function daysDiff(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24);
}

function makeNotification(
  issueRef: string,
  config: IssueConfig,
  type: NotificationType,
  actor: string,
  summary: string,
  detail: string,
): Notification {
  return {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    issue_ref: issueRef,
    type,
    mode_at_time: config.mode,
    priority_at_time: config.priority,
    payload: { actor, summary, detail },
    delivered_to: 'telegram',
    digest_id: null,
  };
}

function isBot(login: string, userType: string, filterBots: boolean): boolean {
  if (!filterBots) return false;
  return userType === 'Bot' || KNOWN_BOTS.has(login);
}

function passesCommentFilter(
  comment: GHComment,
  config: IssueConfig,
  settings: GlobalSettings,
): boolean {
  if (isBot(comment.user.login, comment.user.type, settings.filter_bots)) return false;
  if (comment.body.trim().length < settings.min_comment_length) return false;
  if (config.ignore_users.includes(comment.user.login)) return false;
  return true;
}

/**
 * Returns true only for comments that should trigger a signal in awaiting_reply mode.
 * OWNER/MEMBER/COLLABORATOR are always included as a runtime safety net.
 * Explicitly listed watch_users are also included.
 */
function isRelevantForAwaitingReply(
  login: string,
  association: AuthorAssociation,
  watchUsers: string[],
): boolean {
  if (MAINTAINER_ASSOCIATIONS.includes(association)) return true;
  if (watchUsers.includes(login)) return true;
  return false;
}

/**
 * Build a human-readable summary line for a GitHub issue event.
 * Maps real GitHub API event type strings to readable text.
 */
function summariseEvent(evt: GHEvent): { summary: string; detail: string } {
  const actor = evt.actor?.login ?? 'unknown';

  switch (evt.event) {
    case 'assigned':
      return {
        summary: `@${actor} assigned @${evt.assignee?.login ?? 'unknown'}`,
        detail: '',
      };
    case 'unassigned':
      return {
        summary: `@${actor} unassigned @${evt.assignee?.login ?? 'unknown'}`,
        detail: '',
      };
    case 'labeled':
      return {
        summary: `@${actor} added label "${evt.label?.name ?? 'unknown'}"`,
        detail: '',
      };
    case 'unlabeled':
      return {
        summary: `@${actor} removed label "${evt.label?.name ?? 'unknown'}"`,
        detail: '',
      };
    case 'closed':
      return {
        summary: `@${actor} closed the issue`,
        detail: '',
      };
    case 'reopened':
      return {
        summary: `@${actor} reopened the issue`,
        detail: '',
      };
    case 'renamed':
      return {
        summary: `@${actor} renamed the issue`,
        detail: '',
      };
    case 'cross-referenced':
    case 'connected':
      return {
        summary: `Issue was linked to a PR`,
        detail: `Referenced by @${actor}`,
      };
    case 'merged':
      return {
        summary: `Linked PR was merged`,
        detail: `Merged by @${actor}`,
      };
    case 'milestoned':
      return {
        summary: `@${actor} added to a milestone`,
        detail: '',
      };
    case 'demilestoned':
      return {
        summary: `@${actor} removed from milestone`,
        detail: '',
      };
    case 'review_requested':
      return {
        summary: `@${actor} requested a review`,
        detail: '',
      };
    case 'mentioned':
      return {
        summary: `@${actor} was mentioned`,
        detail: '',
      };
    default:
      return {
        summary: `@${actor} triggered "${evt.event}"`,
        detail: '',
      };
  }
}

// ─── Main export ───────────────────────────────────────────────────────────────

export interface DetectionResult {
  notifications: Notification[];
  /** Partial state updates to merge into IssueState after this run */
  updatedState: Partial<IssueState>;
}

export function detectSignals(
  issueRef: string,
  config: IssueConfig,
  state: IssueState,
  rawComments: GHComment[],
  rawEvents: GHEvent[],
  settings: GlobalSettings,
  now: Date,
): DetectionResult {
  const notifications: Notification[] = [];
  const updatedState: Partial<IssueState> = {};

  // ── Snooze check ─────────────────────────────────────────────────────────────
  if (config.snooze_until && new Date(config.snooze_until) > now) {
    console.log(`  [${issueRef}] Snoozed until ${config.snooze_until}, skipping.`);
    return { notifications: [], updatedState: {} };
  }

  // ── Step A: Filter events upfront ────────────────────────────────────────────
  // All event processing from this point uses filteredEvents only.
  // rawEvents are never touched again.
  const filteredEvents = rawEvents.filter((evt) => {
    const login = evt.actor?.login ?? '';
    const userType = evt.actor?.type ?? 'User';
    if (isBot(login, userType, settings.filter_bots)) return false;
    if (config.ignore_users.includes(login)) return false;
    return true;
  });

  // ── Step B: Filter comments ───────────────────────────────────────────────────
  const comments = rawComments.filter((c) => passesCommentFilter(c, config, settings));

  // ── Step C: Track latest IDs and timestamps for state update ──────────────────
  // last_activity_at is updated from BOTH filtered comments and filtered events.
  // Bot-triggered events do NOT update last_activity_at (they don't reset inactivity).
  const prevActivityAt = state.last_activity_at ? new Date(state.last_activity_at) : null;
  let latestActivityAt = prevActivityAt;
  let latestCommentId = state.last_comment_id;
  let latestEventId = state.last_event_id;

  if (comments.length > 0) {
    const maxId = Math.max(...comments.map((c) => c.id));
    if (!latestCommentId || maxId > latestCommentId) latestCommentId = maxId;

    const latestDate = new Date(
      Math.max(...comments.map((c) => new Date(c.created_at).getTime())),
    );
    if (!latestActivityAt || latestDate > latestActivityAt) latestActivityAt = latestDate;
  }

  if (filteredEvents.length > 0) {
    // Track max event ID across ALL raw events (for dedup on next run), not just filtered.
    // But updated last_activity_at only from human events.
    const rawMaxId = Math.max(...rawEvents.map((e) => e.id));
    if (!latestEventId || rawMaxId > latestEventId) latestEventId = rawMaxId;

    const latestDate = new Date(
      Math.max(...filteredEvents.map((e) => new Date(e.created_at).getTime())),
    );
    if (!latestActivityAt || latestDate > latestActivityAt) latestActivityAt = latestDate;
  } else if (rawEvents.length > 0) {
    // Even if all events were bots, still advance last_event_id so we don't re-process.
    const rawMaxId = Math.max(...rawEvents.map((e) => e.id));
    if (!latestEventId || rawMaxId > latestEventId) latestEventId = rawMaxId;
  }

  updatedState.last_comment_id = latestCommentId;
  updatedState.last_event_id = latestEventId;
  if (latestActivityAt) {
    updatedState.last_activity_at = latestActivityAt.toISOString();
  }

  // hasNewActivity is true only for human-initiated activity (bot events excluded).
  const hasNewActivity = comments.length > 0 || filteredEvents.length > 0;

  // ── Step D: Event notifications (all modes, all events) ───────────────────────
  // Every filtered (non-bot, non-ignored) event generates a notification.
  // No mode check — events are facts and all modes care about them.
  for (const evt of filteredEvents) {
    const actor = evt.actor?.login ?? 'unknown';
    const { summary, detail } = summariseEvent(evt);
    notifications.push(
      makeNotification(issueRef, config, 'status_change', actor, summary, detail),
    );
  }

  // ── Step E: Activity spike detection (all modes) ──────────────────────────────
  if (
    prevActivityAt &&
    comments.length >= SPIKE_COMMENT_THRESHOLD &&
    daysDiff(prevActivityAt, now) >= SPIKE_SILENCE_DAYS
  ) {
    const firstActors = [...new Set(comments.slice(0, 5).map((c) => `@${c.user.login}`))].join(
      ', ',
    );
    notifications.push(
      makeNotification(
        issueRef,
        config,
        'spike',
        comments[0]?.user.login ?? 'unknown',
        `Activity spike: ${comments.length} new comments after ${Math.floor(daysDiff(prevActivityAt, now))} days of silence`,
        `Active users: ${firstActors}`,
      ),
    );
  }

  // ── Step F: Mode-specific comment signals ─────────────────────────────────────

  if (config.mode === 'awaiting_reply') {
    // Only notify for comments from maintainers or explicitly watched users.
    const relevantComments = comments.filter((c) =>
      isRelevantForAwaitingReply(c.user.login, c.author_association, config.watch_users),
    );
    for (const comment of relevantComments) {
      notifications.push(
        makeNotification(
          issueRef,
          config,
          'comment',
          comment.user.login,
          `@${comment.user.login} commented`,
          comment.body.slice(0, 200),
        ),
      );
    }
  }

  // inactivity_watch and wip_watch: time-based inactivity detection.
  if (config.mode === 'inactivity_watch' || config.mode === 'wip_watch') {
    if (!hasNewActivity && prevActivityAt) {
      const daysSilent = daysDiff(prevActivityAt, now);

      if (daysSilent >= config.inactivity_threshold_days) {
        const alreadyAlerted = state.inactivity_alerted;
        const lastAlertedAt = state.inactivity_last_alerted_at
          ? new Date(state.inactivity_last_alerted_at)
          : null;
        const daysSinceAlert = lastAlertedAt ? daysDiff(lastAlertedAt, now) : Infinity;

        if (!alreadyAlerted || daysSinceAlert >= config.stale_re_alert_days) {
          notifications.push(
            makeNotification(
              issueRef,
              config,
              'inactivity',
              'system',
              `Inactive for ${Math.floor(daysSilent)} days`,
              `No activity since ${prevActivityAt.toISOString().split('T')[0]}`,
            ),
          );
          updatedState.inactivity_alerted = true;
          updatedState.inactivity_last_alerted_at = now.toISOString();
        }
      }
    } else if (hasNewActivity) {
      updatedState.inactivity_alerted = false;
      updatedState.inactivity_last_alerted_at = null;
    }
  }

  return { notifications, updatedState };
}
