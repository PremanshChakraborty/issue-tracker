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
]);

const SPIKE_COMMENT_THRESHOLD = 3;  // ≥3 comments in one window
const SPIKE_SILENCE_DAYS = 7;       // after ≥7 days of silence

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
 * Check if an actor should generate a signal in awaiting_reply mode.
 * Always includes OWNER/MEMBER/COLLABORATOR (safety net).
 * Also includes anyone explicitly listed in watch_users.
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

  // ── Snooze check ────────────────────────────────────────────────────────────
  if (config.snooze_until && new Date(config.snooze_until) > now) {
    console.log(`  [${issueRef}] Snoozed until ${config.snooze_until}, skipping.`);
    return { notifications: [], updatedState: {} };
  }

  // ── Filter comments ──────────────────────────────────────────────────────────
  const comments = rawComments.filter((c) => passesCommentFilter(c, config, settings));
  const filteredEventActors = new Set(
    rawEvents
      .map((e) => e.actor?.login)
      .filter((l): l is string => !!l && !config.ignore_users.includes(l)),
  );

  // ── Track latest state for state update ──────────────────────────────────────
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

  if (rawEvents.length > 0) {
    const maxId = Math.max(...rawEvents.map((e) => e.id));
    if (!latestEventId || maxId > latestEventId) latestEventId = maxId;

    const latestDate = new Date(
      Math.max(...rawEvents.map((e) => new Date(e.created_at).getTime())),
    );
    if (!latestActivityAt || latestDate > latestActivityAt) latestActivityAt = latestDate;
  }

  updatedState.last_comment_id = latestCommentId;
  updatedState.last_event_id = latestEventId;
  if (latestActivityAt) {
    updatedState.last_activity_at = latestActivityAt.toISOString();
  }

  const hasNewActivity = comments.length > 0 || rawEvents.length > 0;

  // ── Activity spike detection (all modes) ──────────────────────────────────────
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

  // ── Mode: awaiting_reply ──────────────────────────────────────────────────────
  if (config.mode === 'awaiting_reply') {
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

  // ── Mode: inactivity_watch | wip_watch (inactivity-based) ────────────────────
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
      // New activity resets inactivity state
      updatedState.inactivity_alerted = false;
      updatedState.inactivity_last_alerted_at = null;
    }

    // wip_watch: detect assignment dropped
    if (config.mode === 'wip_watch') {
      const unassignedEvents = rawEvents.filter((e) => e.event === 'unassigned');
      for (const evt of unassignedEvents) {
        if (config.ignore_users.includes(evt.actor?.login ?? '')) continue;
        notifications.push(
          makeNotification(
            issueRef,
            config,
            'status_change',
            evt.actor?.login ?? 'unknown',
            `Assignment dropped: @${evt.assignee?.login ?? 'unknown'} was unassigned`,
            'Issue may be available to pick up',
          ),
        );
      }
    }
  }

  // ── Event-based signals (all modes): closed / reopened ────────────────────────
  for (const evt of rawEvents) {
    const actor = evt.actor?.login ?? 'unknown';
    if (config.ignore_users.includes(actor)) continue;
    if (isBot(actor, evt.actor?.type ?? 'User', settings.filter_bots)) continue;

    if (evt.event === 'closed') {
      notifications.push(
        makeNotification(
          issueRef,
          config,
          'status_change',
          actor,
          'Issue closed',
          `Closed by @${actor}`,
        ),
      );
    }

    if (evt.event === 'reopened') {
      notifications.push(
        makeNotification(
          issueRef,
          config,
          'status_change',
          actor,
          'Issue reopened',
          `Reopened by @${actor}`,
        ),
      );
    }
  }

  return { notifications, updatedState };
}
