// ─── Primitives ───────────────────────────────────────────────────────────────

export type IssueMode = 'awaiting_reply' | 'inactivity_watch' | 'wip_watch';

export type Priority = 'critical' | 'watching' | 'low';

export type EventType =
  | 'comments'
  | 'labels'
  | 'status'
  | 'assignment'
  | 'pr_linked'
  | 'pr_merged'
  | 'reopened';

export type DigestOverride = 'instant' | 'digest';

export type NotificationType =
  | 'comment'
  | 'inactivity'
  | 'status_change'
  | 'spike'
  | 'digest';

// ─── settings.json ────────────────────────────────────────────────────────────

export interface GlobalSettings {
  cron_interval_minutes: number;
  digest_mode: boolean;
  digest_time: string;           // "HH:MM" 24h
  quiet_hours_start: string;     // "HH:MM" 24h
  quiet_hours_end: string;       // "HH:MM" 24h
  filter_bots: boolean;
  min_comment_length: number;
  default_mode: IssueMode;
}

// ─── watchlist.json ───────────────────────────────────────────────────────────

export interface IssueConfig {
  repo: string;                        // "owner/repo"
  issue_number: number;
  title: string;
  added_at: string;                    // ISO timestamp
  mode: IssueMode;
  priority: Priority;
  inactivity_threshold_days: number;
  stale_re_alert_days: number;
  watch_users: string[];               // GitHub usernames to watch
  ignore_users: string[];              // GitHub usernames to ignore
  notify_on: EventType[];
  digest_override: DigestOverride;
  priority_bypass_quiet_hours: boolean;
  snooze_until: string | null;         // ISO timestamp or null
  notes: string;
  auto_remove_on_close: boolean;
}

export interface Watchlist {
  issues: Record<string, IssueConfig>; // key: "owner/repo#number"
}

// ─── state.json ───────────────────────────────────────────────────────────────

export interface IssueState {
  last_comment_id: number | null;
  last_event_id: number | null;
  last_activity_at: string | null;      // ISO timestamp
  inactivity_alerted: boolean;
  inactivity_last_alerted_at: string | null; // ISO timestamp
  last_telegram_message_id: number | null;
}

export interface TrackerState {
  last_run: string | null;              // ISO timestamp
  issues: Record<string, IssueState>;  // key: "owner/repo#number"
}

// ─── notifications.json ───────────────────────────────────────────────────────

export interface NotificationPayload {
  actor: string;
  summary: string;
  detail: string;
}

export interface Notification {
  id: string;                          // UUID v4
  timestamp: string;                   // ISO timestamp
  issue_ref: string;                   // "owner/repo#number"
  type: NotificationType;
  mode_at_time: IssueMode;
  priority_at_time: Priority;
  payload: NotificationPayload;
  delivered_to: 'telegram' | 'undelivered';
  digest_id: string | null;
}

// ─── Mode defaults ────────────────────────────────────────────────────────────

export const ALL_EVENT_TYPES: EventType[] = [
  'comments',
  'labels',
  'status',
  'assignment',
  'pr_linked',
  'pr_merged',
  'reopened',
];

export const MODE_DEFAULTS: Record<IssueMode, Partial<IssueConfig>> = {
  awaiting_reply: {
    priority: 'critical',
    inactivity_threshold_days: 3,
    stale_re_alert_days: 2,
    notify_on: ALL_EVENT_TYPES,
    digest_override: 'instant',
    priority_bypass_quiet_hours: true,
    auto_remove_on_close: true,
  },
  inactivity_watch: {
    priority: 'watching',
    inactivity_threshold_days: 14,
    stale_re_alert_days: 7,
    notify_on: ALL_EVENT_TYPES,
    digest_override: 'digest',
    priority_bypass_quiet_hours: false,
    auto_remove_on_close: false,
  },
  wip_watch: {
    priority: 'low',
    inactivity_threshold_days: 21,
    stale_re_alert_days: 10,
    notify_on: ALL_EVENT_TYPES,
    digest_override: 'digest',
    priority_bypass_quiet_hours: false,
    auto_remove_on_close: true,
  },
};
