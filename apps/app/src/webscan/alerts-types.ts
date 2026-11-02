import type { RetainedOccurrence, Severity, Validation } from '@mergepilot/webscan';
import type {
  WebScanAlertEpisode,
  WebScanAlertIssueState,
  WebScanException,
  WebScanExceptionKind,
  WebScanExceptionReasonCategory,
} from './types.js';

/**
 * The contracts of the alert engine (ADR-0052 section 8).
 *
 * The engine is pure: it takes the ledger of a site, its resolutions, its
 * bounded episode state and the state of the referenced issues, and it returns
 * the next episode state and the actions the delivery layer has to perform.
 * It never fetches an issue, never writes a row and never reads a clock.
 */

/**
 * The observed state of the issue of one alert episode.
 *
 * It is the state the persisted episode carries, so the engine and the stored
 * state never drift apart.
 */
export type AlertIssueState = WebScanAlertIssueState;

/** The kind of a write of an episode that carries a delivery marker. */
export type AlertMarkerKind =
  | 'issue'
  | 'fixed-comment'
  | 'resolved-by-exception-comment'
  | 'mark-unknown';

/** The state of the issue of one episode, as observed by the caller. */
export interface AlertIssueObservation {
  episodeKey: string;
  state: AlertIssueState;
}

/** The thresholds and the switch of the alerts. */
export interface AlertThresholds {
  /** Whether notifications may be delivered at all. */
  alertsEnabled: boolean;
  /** The lowest severity that opens an issue. */
  alertMinSeverity: Severity;
  /** The lowest validation that opens an issue. */
  alertMinValidation: Validation;
}

/** Everything one evaluation of the alert state needs. */
export interface AlertEvaluationInput {
  /** The scan that triggered the evaluation. A manual scan never delivers. */
  trigger: 'scheduled' | 'manual';
  /** The instant of the evaluation. */
  now: Date;
  /** The opaque id of the site. It is never the hostname. */
  siteId: string;
  /** The base URL of the platform dashboard. */
  dashboardBaseUrl: string;
  /** The thresholds and the switch. */
  thresholds: AlertThresholds;
  /** The bounded episode state of the site. */
  episodes: readonly WebScanAlertEpisode[];
  /** The retained ledger of the site. */
  occurrences: readonly RetainedOccurrence[];
  /** The resolutions of the site. Only the live ones are honoured. */
  exceptions: readonly WebScanException[];
  /**
   * The state of the issue of every episode, as observed by the caller.
   *
   * The caller reports every episode that has an issue requested (ADR-0052 section 8:
   * the state of every referenced issue is fetched before eligibility). An issue that
   * was requested but does not exist (the delivery was refused, or it was never
   * created) is reported as `missing`: that is what frees a resolved episode and what
   * lets the next scheduled scan offer the issue again. An episode with a requested
   * issue and no report keeps its slot, because the issue may exist.
   *
   * The outcome the engine records on an episode when it emits a comment is the
   * reservation of that delivery (ADR-0052 section 8 reserves a durable delivery row
   * before it writes): the delivery layer reconciles an ambiguous write by marker.
   */
  issueStates?: readonly AlertIssueObservation[];
}

/** The aggregate counts by severity of one publication. */
export type AlertSeverityCounts = Readonly<Record<Severity, number>>;

/** The common fields of every action. */
interface AlertActionBase {
  /** The episode the action belongs to. */
  episodeKey: string;
  /**
   * The deterministic marker of this action. It is the idempotency key of the
   * write: the same action of the same episode always carries the same marker.
   */
  deliveryMarker: string;
  /** The deterministic marker of the issue of the episode. */
  issueMarker: string;
}

/** The action that opens the issue of an episode. */
export interface AlertOpenIssueAction extends AlertActionBase {
  kind: 'open-issue';
  /** The aggregate counts by severity of the eligible members. */
  severityCounts: AlertSeverityCounts;
  /** The platform dashboard link of the site. */
  dashboardUrl: string;
}

/** The action that comments on the issue of a proven fixed episode. */
export interface AlertFixedCommentAction extends AlertActionBase {
  kind: 'fixed-comment';
  /** The aggregate counts by severity of the proven fixed members. */
  severityCounts: AlertSeverityCounts;
  /** The platform dashboard link of the site. */
  dashboardUrl: string;
}

/** The action that comments on the issue of a group an administrator resolved. */
export interface AlertExceptionCommentAction extends AlertActionBase {
  kind: 'resolved-by-exception-comment';
  /** The aggregate counts by severity of the resolved members. */
  severityCounts: AlertSeverityCounts;
  /** The platform dashboard link of the site. */
  dashboardUrl: string;
  /**
   * The resolution that unblocked the group.
   *
   * It names the bounded kind and reason category and the expiry. The
   * free-form reason of the resolution is never part of it.
   */
  exception: {
    kind: WebScanExceptionKind;
    reasonCategory: WebScanExceptionReasonCategory;
    /** The expiry of the resolution, or null when it never expires. */
    expiresAt: string | null;
  };
}

/** The action that marks the issue of an episode as unknown. */
export interface AlertUnknownAction extends AlertActionBase {
  kind: 'mark-unknown';
}

/** Every action the delivery layer can perform. */
export type AlertAction =
  | AlertOpenIssueAction
  | AlertFixedCommentAction
  | AlertExceptionCommentAction
  | AlertUnknownAction;

/** The result of one evaluation. */
export interface AlertEvaluation {
  /** The episode state to persist on the site row. */
  episodes: WebScanAlertEpisode[];
  /** The actions the delivery layer has to perform, in a deterministic order. */
  actions: AlertAction[];
}
