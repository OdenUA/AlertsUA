import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { DatabaseService } from '../../common/database/database.service';
import { InstallationsService } from '../installations/installations.service';
import { SupabaseSyncService } from '../supabase/supabase-sync.service';
import { TimeUtil } from '../../common/utils/time.util';
import { CreateSubscriptionDto } from './dto/create-subscription.dto';
import { UpdateSubscriptionDto } from './dto/update-subscription.dto';

type AlertStatus = 'A' | 'P' | 'N' | ' ';

type SubscriptionViewRow = {
  subscription_id: string;
  installation_id: string;
  label_user: string | null;
  address_uk: string;
  latitude: number;
  longitude: number;
  leaf_uid: number | null;
  raion_uid: number | null;
  oblast_uid: number | null;
  leaf_title_uk: string | null;
  notify_on_start: boolean;
  notify_on_end: boolean;
  is_active: boolean;
  current_status: AlertStatus;
  created_at: string;
  updated_at: string;
};

type ResolvedPointRow = {
  leaf_uid: number;
  leaf_type: 'hromada' | 'city';
  leaf_title_uk: string;
  raion_uid: number | null;
  oblast_uid: number | null;
};

type AncestorTitleRow = {
  uid: number;
  title_uk: string;
};

type StateRow = {
  uid: number;
  status: AlertStatus;
  active_from: string | null;
  state_version: number;
};

type AggregateStatusRow = {
  level: 'raion' | 'oblast';
  uid: number;
  status: AlertStatus;
};

type RuntimeRow = {
  subscription_id: string;
  effective_status: AlertStatus;
  effective_uid: number | null;
  effective_started_at: string | null;
  last_transition_at: string;
  last_evaluated_state_version: number;
  last_start_event_id: string | null;
  last_end_event_id: string | null;
};

type EventRow = {
  event_id: string;
  uid: number;
  event_kind: 'started' | 'ended' | 'state_changed';
};

type SubscriptionRuntimeSourceRow = {
  subscription_id: string;
  installation_id: string;
  label_user: string | null;
  address_uk: string;
  leaf_uid: number | null;
  raion_uid: number | null;
  oblast_uid: number | null;
  leaf_title_uk: string | null;
  raion_title_uk: string | null;
  oblast_title_uk: string | null;
  notify_on_start: boolean;
  notify_on_end: boolean;
  is_active: boolean;
  notifications_enabled: boolean;
  installation_status: string;
};

type PushTokenRow = {
  token_id: string;
  installation_id: string;
};

type ScopedSubscriptionSource = {
  label_user?: string | null;
  leaf_uid: number | null;
  raion_uid: number | null;
  oblast_uid: number | null;
};

type SubscriptionScope = 'hromada' | 'raion' | 'oblast';

type EffectiveState = {
  effective_status: AlertStatus;
  effective_uid: number | null;
  effective_started_at: string | null;
};

type OblastActiveHistoryRow = {
  region_type: 'raion' | 'hromada' | 'city';
  region_title_uk: string;
  raion_title_uk: string | null;
  started_at: string;
  alert_type: string;
};

type OblastEndedHistoryRow = {
  uid: number;
  region_type: 'raion' | 'hromada' | 'city';
  region_title_uk: string;
  raion_title_uk: string | null;
  group_raion_uid: number | null;
  started_at: string;
  ended_at: string | null;
  alert_type: string;
};

type RaionLeafCountRow = {
  raion_uid: number;
  raion_title_uk: string;
  total_leaf_count: string;
};

type QueryExecutor = DatabaseService | PoolClient;

const ACTIVE_STATUSES = new Set<AlertStatus>(['A', 'P']);

@Injectable()
export class SubscriptionsService {
  private kyivOblastUidCache: number | null | undefined;

  constructor(
    private readonly installationsService: InstallationsService,
    private readonly databaseService: DatabaseService,
    private readonly supabaseSyncService: SupabaseSyncService,
  ) {}

  async resolvePoint(latitude: number, longitude: number) {
    this.ensureDatabaseConfigured();
    const point = await this.resolvePointWithDisplayContext(this.databaseService, latitude, longitude);
    const [stateContext, ancestorTitles] = await Promise.all([
      this.loadStateContext(
        this.databaseService,
        point.leaf_uid,
        point.raion_uid,
        point.oblast_uid,
      ),
      this.loadAncestorTitles(this.databaseService, point.raion_uid, point.oblast_uid),
    ]);

    const hromadaState = stateContext.statesByUid.get(point.leaf_uid);
    const raionState   = point.raion_uid  ? stateContext.statesByUid.get(point.raion_uid)  : null;
    const oblastState  = point.oblast_uid ? stateContext.statesByUid.get(point.oblast_uid) : null;
    const aggregateStatuses = await this.loadAggregateStatuses(
      this.databaseService,
      point.raion_uid,
      point.oblast_uid,
    );
    const oblastHistory = point.oblast_uid
      ? await this.loadOblastHistory(point.oblast_uid)
      : { active: [], today: [], yesterday: [] };

    const hromadaStatus = hromadaState?.status ?? ' ';
    const raionStatus   = point.raion_uid
      ? (aggregateStatuses.raionStatus ?? raionState?.status ?? ' ')
      : null;
    const oblastStatus  = point.oblast_uid
      ? (aggregateStatuses.oblastStatus ?? oblastState?.status ?? ' ')
      : null;

    // Find earliest active_from among 'A' statuses
    const activeItems = [
      hromadaStatus === 'A' ? hromadaState : undefined,
      raionStatus === 'A' ? raionState : undefined,
      oblastStatus === 'A' ? oblastState : undefined,
    ].filter((s): s is StateRow => !!s);
    activeItems.sort((a, b) => (a.active_from ?? '').localeCompare(b.active_from ?? ''));
    const activeFrom = activeItems[0]?.active_from ?? null;

    return {
      address_uk: this.buildAddressLabel(point.leaf_title_uk),
      resolved_region: {
        leaf_uid:  point.leaf_uid,
        leaf_type: point.leaf_type,
        // Hromada level
        hromada_title_uk: point.leaf_title_uk,
        hromada_status:   hromadaStatus,
        // Raion level
        raion_uid:      point.raion_uid,
        raion_title_uk: ancestorTitles.raionTitle,
        raion_status:   raionStatus,
        // Oblast level
        oblast_uid:      point.oblast_uid,
        oblast_title_uk: ancestorTitles.oblastTitle,
        oblast_status:   oblastStatus,
        // Active alert start time (earliest A status)
        active_from: activeFrom,
        // Oblast-wide history for today / yesterday in bottom sheet
        oblast_history: oblastHistory,
        // Legacy fields kept for backward compatibility
        leaf_title_uk:          point.leaf_title_uk,
        current_status:         hromadaStatus,
        current_status_label_uk: this.getStatusLabelUk(hromadaStatus),
      },
      latitude,
      longitude,
    };
  }

  async create(token: string, dto: CreateSubscriptionDto) {
    this.ensureDatabaseConfigured();
    const installation = await this.installationsService.requireByToken(token);

    return this.databaseService.withTransaction(async (client) => {
      const resolvedPoint = await this.resolvePointInternal(client, dto.latitude, dto.longitude);
      const stateContext = await this.loadStateContext(
        client,
        resolvedPoint.leaf_uid,
        resolvedPoint.raion_uid,
        resolvedPoint.oblast_uid,
      );
      const effectiveState = this.evaluateEffectiveState(
        {
          ...resolvedPoint,
          label_user: dto.label_user ?? null,
        },
        stateContext.statesByUid,
      );
      const subscriptionId = randomUUID();
      const now = TimeUtil.getNowInKyiv();

      await client.query(
        `
          INSERT INTO subscriptions (
            subscription_id,
            installation_id,
            label_user,
            address_uk,
            latitude,
            longitude,
            point,
            leaf_uid,
            raion_uid,
            oblast_uid,
            notify_on_start,
            notify_on_end,
            is_active,
            created_at,
            updated_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6,
            ST_SetSRID(ST_MakePoint($6, $5), 4326),
            $7, $8, $9, $10, $11, TRUE, $12, $12
          )
        `,
        [
          subscriptionId,
          installation.installation_id,
          dto.label_user ?? null,
          this.buildAddressLabel(resolvedPoint.leaf_title_uk),
          dto.latitude,
          dto.longitude,
          resolvedPoint.leaf_uid,
          resolvedPoint.raion_uid,
          resolvedPoint.oblast_uid,
          dto.notify_on_start,
          dto.notify_on_end,
          now,
        ],
      );

      await client.query(
        `
          INSERT INTO subscription_runtime_state (
            subscription_id,
            effective_status,
            effective_uid,
            effective_started_at,
            last_transition_at,
            last_evaluated_state_version,
            last_start_event_id,
            last_end_event_id
          ) VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL)
        `,
        [
          subscriptionId,
          effectiveState.effective_status,
          effectiveState.effective_uid,
          effectiveState.effective_started_at,
          now,
          stateContext.stateVersion,
        ],
      );

      const createdView = await this.getOwnedSubscriptionView(
        client,
        installation.installation_id,
        subscriptionId,
      );

      await this.supabaseSyncService.enqueueEntity(client, {
        entity_type: 'subscriptions',
        entity_id: subscriptionId,
        operation: 'insert',
        payload: this.toSubscriptionSyncPayload(createdView),
      });

      return createdView;
    });
  }

  async list(token: string) {
    this.ensureDatabaseConfigured();
    const installation = await this.installationsService.requireByToken(token);
    const result = await this.getSubscriptionViewsByInstallation(installation.installation_id);
    return {
      subscriptions: result,
    };
  }

  async update(token: string, subscriptionId: string, dto: UpdateSubscriptionDto) {
    this.ensureDatabaseConfigured();
    const installation = await this.installationsService.requireByToken(token);

    return this.databaseService.withTransaction(async (client) => {
      const existing = await this.getOwnedSubscriptionView(
        client,
        installation.installation_id,
        subscriptionId,
      );
      const now = TimeUtil.getNowInKyiv();

      await client.query(
        `
          UPDATE subscriptions
          SET label_user = $3,
              notify_on_start = $4,
              notify_on_end = $5,
              is_active = $6,
              updated_at = $7
          WHERE subscription_id = $1
            AND installation_id = $2
        `,
        [
          subscriptionId,
          installation.installation_id,
          dto.label_user !== undefined ? dto.label_user : existing.label_user,
          dto.notify_on_start !== undefined ? dto.notify_on_start : existing.notify_on_start,
          dto.notify_on_end !== undefined ? dto.notify_on_end : existing.notify_on_end,
          dto.is_active !== undefined ? dto.is_active : existing.is_active,
          now,
        ],
      );

      const updatedView = await this.getOwnedSubscriptionView(
        client,
        installation.installation_id,
        subscriptionId,
      );

      await this.supabaseSyncService.enqueueEntity(client, {
        entity_type: 'subscriptions',
        entity_id: subscriptionId,
        operation: 'update',
        payload: this.toSubscriptionSyncPayload(updatedView),
      });

      return updatedView;
    });
  }

  async remove(token: string, subscriptionId: string) {
    this.ensureDatabaseConfigured();
    const installation = await this.installationsService.requireByToken(token);

    await this.databaseService.withTransaction(async (client) => {
      const result = await client.query<{ subscription_id: string }>(
        `
          DELETE FROM subscriptions
          WHERE subscription_id = $1
            AND installation_id = $2
          RETURNING subscription_id
        `,
        [subscriptionId, installation.installation_id],
      );

      if (result.rowCount === 0) {
        throw new NotFoundException('Підписку не знайдено.');
      }

      await this.supabaseSyncService.enqueueEntity(client, {
        entity_type: 'subscriptions',
        entity_id: subscriptionId,
        operation: 'delete',
        payload: {
          subscription_id: subscriptionId,
        },
      });
    });

    return {
      deleted: true,
      subscription_id: subscriptionId,
    };
  }

  async synchronizeRuntimeState(
    client: PoolClient,
    input: {
      state_version: number;
      occurred_at: Date;
    },
  ) {
    const [subscriptionsResult, runtimeResult, statesResult, eventsResult, pushTokensResult] =
      await Promise.all([
        client.query<SubscriptionRuntimeSourceRow>(
          `
            SELECT s.subscription_id,
                   s.installation_id,
                   s.label_user,
                   s.address_uk,
                   s.leaf_uid,
                   s.raion_uid,
                   s.oblast_uid,
                   rc_leaf.title_uk  AS leaf_title_uk,
                   rc_raion.title_uk AS raion_title_uk,
                   rc_oblast.title_uk AS oblast_title_uk,
                   s.notify_on_start,
                   s.notify_on_end,
                   s.is_active,
                   di.notifications_enabled,
                   di.status AS installation_status
            FROM subscriptions s
            JOIN device_installations di ON di.installation_id = s.installation_id
            LEFT JOIN region_catalog rc_leaf   ON rc_leaf.uid   = s.leaf_uid
            LEFT JOIN region_catalog rc_raion  ON rc_raion.uid  = s.raion_uid
            LEFT JOIN region_catalog rc_oblast ON rc_oblast.uid = s.oblast_uid
          `,
        ),
        client.query<RuntimeRow>(
          `
            SELECT subscription_id,
                   effective_status,
                   effective_uid,
                   effective_started_at::text,
                   last_transition_at::text,
                   last_evaluated_state_version,
                   last_start_event_id,
                   last_end_event_id
            FROM subscription_runtime_state
            FOR UPDATE
          `,
        ),
        client.query<StateRow>(
          `
            SELECT uid, status, active_from::text, state_version
            FROM air_raid_state_current
          `,
        ),
        client.query<EventRow>(
          `
            SELECT event_id, uid, event_kind
            FROM air_raid_events
            WHERE state_version = $1
          `,
          [input.state_version],
        ),
        client.query<PushTokenRow>(
          `
            SELECT token_id, installation_id
            FROM device_push_tokens
            WHERE is_active = TRUE
          `,
        ),
      ]);

    if (subscriptionsResult.rowCount === 0) {
      return {
        updated_subscriptions: 0,
        queued_dispatches: 0,
      };
    }

    const runtimeBySubscription = new Map(
      runtimeResult.rows.map((row) => [row.subscription_id, row]),
    );
    const statesByUid = new Map(statesResult.rows.map((row) => [row.uid, row]));
    const eventsByKey = new Map(
      eventsResult.rows.map((row) => [`${row.uid}:${row.event_kind}`, row.event_id]),
    );
    const tokensByInstallation = new Map<string, PushTokenRow[]>();

    for (const row of pushTokensResult.rows) {
      const current = tokensByInstallation.get(row.installation_id) ?? [];
      current.push(row);
      tokensByInstallation.set(row.installation_id, current);
    }

    let updatedSubscriptions = 0;
    let queuedDispatches = 0;
    const transitionAt = input.occurred_at.toISOString();

    for (const subscription of subscriptionsResult.rows) {
      const previousRuntimeRaw = runtimeBySubscription.get(subscription.subscription_id) ?? {
        subscription_id: subscription.subscription_id,
        effective_status: ' ' as AlertStatus,
        effective_uid: null,
        effective_started_at: null,
        last_transition_at: transitionAt,
        last_evaluated_state_version: 0,
        last_start_event_id: null,
        last_end_event_id: null,
      };
      const nextRuntime = this.evaluateEffectiveState(subscription, statesByUid);
      const previousRuntime = this.normalizeRuntimeForScope(
        subscription,
        previousRuntimeRaw,
        nextRuntime,
      );
      const previousWasActive = ACTIVE_STATUSES.has(previousRuntime.effective_status);
      const nextIsActive = ACTIVE_STATUSES.has(nextRuntime.effective_status);
      const stateChanged =
        previousRuntime.effective_status !== nextRuntime.effective_status ||
        previousRuntime.effective_uid !== nextRuntime.effective_uid ||
        previousRuntime.effective_started_at !== nextRuntime.effective_started_at;

      let lastStartEventId = previousRuntimeRaw.last_start_event_id;
      let lastEndEventId = previousRuntimeRaw.last_end_event_id;

      if (!previousWasActive && nextIsActive && nextRuntime.effective_uid !== null) {
        lastStartEventId =
          eventsByKey.get(`${nextRuntime.effective_uid}:started`) ?? previousRuntimeRaw.last_start_event_id;
        queuedDispatches += await this.queueDispatchesForTransition(client, {
          subscription,
          dispatch_kind: 'start',
          event_id: lastStartEventId,
          occurred_at: transitionAt,
          tokens: tokensByInstallation.get(subscription.installation_id) ?? [],
        });
      }

      if (previousWasActive && !nextIsActive && previousRuntime.effective_uid !== null) {
        lastEndEventId =
          eventsByKey.get(`${previousRuntime.effective_uid}:ended`) ?? previousRuntimeRaw.last_end_event_id;
        queuedDispatches += await this.queueDispatchesForTransition(client, {
          subscription,
          dispatch_kind: 'end',
          event_id: lastEndEventId,
          occurred_at: transitionAt,
          tokens: tokensByInstallation.get(subscription.installation_id) ?? [],
        });
      }

      await client.query(
        `
          INSERT INTO subscription_runtime_state (
            subscription_id,
            effective_status,
            effective_uid,
            effective_started_at,
            last_transition_at,
            last_evaluated_state_version,
            last_start_event_id,
            last_end_event_id
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (subscription_id) DO UPDATE SET
            effective_status = EXCLUDED.effective_status,
            effective_uid = EXCLUDED.effective_uid,
            effective_started_at = EXCLUDED.effective_started_at,
            last_transition_at = EXCLUDED.last_transition_at,
            last_evaluated_state_version = EXCLUDED.last_evaluated_state_version,
            last_start_event_id = EXCLUDED.last_start_event_id,
            last_end_event_id = EXCLUDED.last_end_event_id
        `,
        [
          subscription.subscription_id,
          nextRuntime.effective_status,
          nextRuntime.effective_uid,
          nextRuntime.effective_started_at,
          stateChanged ? transitionAt : previousRuntimeRaw.last_transition_at,
          input.state_version,
          lastStartEventId,
          lastEndEventId,
        ],
      );
      updatedSubscriptions += 1;
    }

    return {
      updated_subscriptions: updatedSubscriptions,
      queued_dispatches: queuedDispatches,
    };
  }

  private async queueDispatchesForTransition(
    client: PoolClient,
    input: {
      subscription: SubscriptionRuntimeSourceRow;
      dispatch_kind: 'start' | 'end';
      event_id: string | null;
      occurred_at: string;
      tokens: PushTokenRow[];
    },
  ) {
    if (!input.event_id) {
      return 0;
    }

    if (!input.subscription.is_active || input.subscription.installation_status !== 'active') {
      return 0;
    }

    if (!input.subscription.notifications_enabled) {
      return 0;
    }

    if (input.dispatch_kind === 'start' && !input.subscription.notify_on_start) {
      return 0;
    }

    if (input.dispatch_kind === 'end' && !input.subscription.notify_on_end) {
      return 0;
    }

    const { title_uk, body_uk } = this.buildDispatchText(
      input.dispatch_kind,
      input.subscription.label_user,
      input.subscription.leaf_title_uk,
      input.subscription.raion_title_uk,
      input.subscription.oblast_title_uk,
    );

    let inserted = 0;
    for (const token of input.tokens) {
      const dispatchId = randomUUID();
      const result = await client.query(
        `
          INSERT INTO notification_dispatches (
            dispatch_id,
            subscription_id,
            installation_id,
            token_id,
            event_id,
            dispatch_kind,
            title_uk,
            body_uk,
            status,
            attempt_no,
            provider_message_id,
            provider_error_code,
            queued_at,
            sent_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8,
            'queued', 1, NULL, NULL, $9, NULL
          )
          ON CONFLICT (subscription_id, event_id, dispatch_kind) DO NOTHING
        `,
        [
          dispatchId,
          input.subscription.subscription_id,
          input.subscription.installation_id,
          token.token_id,
          input.event_id,
          input.dispatch_kind,
          title_uk,
          body_uk,
          input.occurred_at,
        ],
      );

      if ((result.rowCount ?? 0) > 0) {
        inserted += 1;
        await this.supabaseSyncService.enqueueEntity(client, {
          entity_type: 'notification_log',
          entity_id: dispatchId,
          operation: 'insert',
          payload: {
            dispatch_id: dispatchId,
            subscription_id: input.subscription.subscription_id,
            installation_id: input.subscription.installation_id,
            event_id: input.event_id,
            dispatch_kind: input.dispatch_kind,
            status: 'queued',
            provider_message_id: null,
            provider_error_code: null,
            queued_at: input.occurred_at,
            sent_at: null,
          },
        });
      }
    }

    return inserted;
  }

  private async loadOblastHistory(oblastUid: number) {
    const [activeResult, endedResult, raionLeafCountResult] = await Promise.all([
      this.databaseService.query<OblastActiveHistoryRow>(
        `
          WITH target_hromadas AS (
            SELECT rc.uid,
                   rc.region_type,
                   rc.title_uk AS region_title_uk,
                   rc.raion_uid,
                   rr.title_uk AS raion_title_uk
            FROM region_catalog rc
            LEFT JOIN region_catalog rr ON rr.uid = rc.raion_uid
            WHERE rc.is_active = TRUE
              AND rc.oblast_uid = $1
              AND rc.region_type IN ('hromada', 'city')
          ),
          active_hromadas AS (
            SELECT th.*,
                   arc.active_from::text AS started_at,
                   arc.alert_type
            FROM target_hromadas th
            JOIN air_raid_state_current arc ON arc.uid = th.uid
            WHERE arc.status = 'A'
              AND arc.active_from IS NOT NULL
          ),
          -- Total hromadas per raion
          raion_total AS (
            SELECT raion_uid, COUNT(*) AS total
            FROM target_hromadas
            WHERE raion_uid IS NOT NULL
            GROUP BY raion_uid
          ),
          -- Active count per raion
          raion_active AS (
            SELECT raion_uid,
                   COUNT(*) AS active_count,
                   MIN(started_at) AS earliest_started_at
            FROM active_hromadas
            WHERE raion_uid IS NOT NULL
            GROUP BY raion_uid
          ),
          -- Dominant alert type per raion (most common among its active hromadas)
          raion_type_counts AS (
            SELECT raion_uid, alert_type, COUNT(*) AS cnt
            FROM active_hromadas WHERE raion_uid IS NOT NULL
            GROUP BY raion_uid, alert_type
          ),
          raion_dominant_type AS (
            SELECT DISTINCT ON (raion_uid) raion_uid, alert_type AS dominant_alert_type
            FROM raion_type_counts
            ORDER BY raion_uid, cnt DESC
          ),
          -- Raions where every hromada is active
          fully_covered_raions AS (
            SELECT ra.raion_uid,
                   ra.earliest_started_at,
                   rdt.dominant_alert_type AS alert_type
            FROM raion_active ra
            JOIN raion_total rt ON rt.raion_uid = ra.raion_uid
            JOIN raion_dominant_type rdt ON rdt.raion_uid = ra.raion_uid
            WHERE ra.active_count = rt.total
          ),
          -- Total raions in this oblast
          all_oblast_raions AS (
            SELECT uid AS raion_uid
            FROM region_catalog
            WHERE is_active = TRUE AND oblast_uid = $1 AND region_type = 'raion'
          ),
          -- Is every raion in the oblast fully covered?
          oblast_coverage AS (
            SELECT (
              (SELECT COUNT(*) FROM fully_covered_raions) =
              (SELECT COUNT(*) FROM all_oblast_raions)
              AND (SELECT COUNT(*) FROM all_oblast_raions) > 0
            ) AS is_fully_covered
          ),
          -- Dominant alert type across all fully covered raions
          oblast_type_counts AS (
            SELECT alert_type, COUNT(*) AS cnt
            FROM fully_covered_raions
            GROUP BY alert_type
          ),
          oblast_dominant_type AS (
            SELECT alert_type FROM oblast_type_counts ORDER BY cnt DESC LIMIT 1
          ),
          oblast_info AS (
            SELECT title_uk FROM region_catalog WHERE uid = $1
          )

          -- ── CASE 1: Oblast fully covered ─────────────────────────────────
          -- Single oblast card with dominant type and earliest start time
          SELECT 'oblast'                      AS region_type,
                 oi.title_uk                  AS region_title_uk,
                 NULL::text                   AS raion_title_uk,
                 MIN(fcr.earliest_started_at) AS started_at,
                 odt.alert_type               AS alert_type
          FROM oblast_coverage oc
          CROSS JOIN oblast_info oi
          CROSS JOIN oblast_dominant_type odt
          JOIN fully_covered_raions fcr ON TRUE
          WHERE oc.is_fully_covered = TRUE
          GROUP BY oi.title_uk, odt.alert_type

          UNION ALL

          -- Exception raions whose dominant type differs from the oblast dominant
          SELECT 'raion'                  AS region_type,
                 rc.title_uk             AS region_title_uk,
                 NULL::text              AS raion_title_uk,
                 fcr.earliest_started_at AS started_at,
                 fcr.alert_type          AS alert_type
          FROM oblast_coverage oc
          CROSS JOIN oblast_dominant_type odt
          JOIN fully_covered_raions fcr ON fcr.alert_type <> odt.alert_type
          JOIN region_catalog rc ON rc.uid = fcr.raion_uid
          WHERE oc.is_fully_covered = TRUE

          UNION ALL

          -- Exception hromadas within conforming raions (type differs from oblast dominant)
          SELECT ah.region_type,
                 ah.region_title_uk,
                 ah.raion_title_uk,
                 ah.started_at,
                 ah.alert_type
          FROM oblast_coverage oc
          CROSS JOIN oblast_dominant_type odt
          JOIN active_hromadas ah ON ah.alert_type <> odt.alert_type
          -- only within raions that themselves conform to the dominant type
          JOIN fully_covered_raions fcr
            ON fcr.raion_uid = ah.raion_uid
           AND fcr.alert_type = odt.alert_type
          WHERE oc.is_fully_covered = TRUE

          UNION ALL

          -- Exception hromadas within exception raions (type differs from raion dominant)
          SELECT ah.region_type,
                 ah.region_title_uk,
                 ah.raion_title_uk,
                 ah.started_at,
                 ah.alert_type
          FROM oblast_coverage oc
          CROSS JOIN oblast_dominant_type odt
          JOIN fully_covered_raions fcr ON fcr.alert_type <> odt.alert_type
          JOIN active_hromadas ah ON ah.raion_uid = fcr.raion_uid
          WHERE oc.is_fully_covered = TRUE
            AND ah.alert_type <> fcr.alert_type

          -- ── CASE 2: Oblast NOT fully covered (existing logic) ────────────
          UNION ALL

          -- Consolidated raion cards
          SELECT 'raion'                  AS region_type,
                 rc.title_uk             AS region_title_uk,
                 NULL::text              AS raion_title_uk,
                 fcr.earliest_started_at AS started_at,
                 fcr.alert_type          AS alert_type
          FROM oblast_coverage oc
          JOIN fully_covered_raions fcr ON TRUE
          JOIN region_catalog rc ON rc.uid = fcr.raion_uid
          WHERE oc.is_fully_covered = FALSE

          UNION ALL

          -- Individual hromadas not in any fully covered raion
          SELECT ah.region_type,
                 ah.region_title_uk,
                 ah.raion_title_uk,
                 ah.started_at,
                 ah.alert_type
          FROM oblast_coverage oc
          JOIN active_hromadas ah
            ON ah.raion_uid IS NULL
            OR ah.raion_uid NOT IN (SELECT raion_uid FROM fully_covered_raions)
          WHERE oc.is_fully_covered = FALSE

          UNION ALL

          -- Exception hromadas within fully covered raions (type differs from raion dominant)
          SELECT ah.region_type,
                 ah.region_title_uk,
                 ah.raion_title_uk,
                 ah.started_at,
                 ah.alert_type
          FROM oblast_coverage oc
          JOIN fully_covered_raions fcr ON TRUE
          JOIN active_hromadas ah ON ah.raion_uid = fcr.raion_uid
          WHERE oc.is_fully_covered = FALSE
            AND ah.alert_type <> fcr.alert_type

          UNION ALL

          -- Direct raion-level alerts not yet consolidated
          SELECT tr.region_type,
                 tr.region_title_uk,
                 NULL::text            AS raion_title_uk,
                 arc.active_from::text AS started_at,
                 arc.alert_type
          FROM oblast_coverage oc
          JOIN (
            SELECT rc.uid, rc.region_type, rc.title_uk AS region_title_uk
            FROM region_catalog rc
            WHERE rc.is_active = TRUE
              AND rc.oblast_uid = $1
              AND rc.region_type = 'raion'
              AND rc.uid NOT IN (SELECT raion_uid FROM fully_covered_raions)
          ) tr ON TRUE
          JOIN air_raid_state_current arc ON arc.uid = tr.uid
          WHERE arc.status = 'A'
            AND arc.active_from IS NOT NULL
            AND oc.is_fully_covered = FALSE

          ORDER BY started_at DESC
        `,
        [oblastUid],
      ),
      this.databaseService.query<OblastEndedHistoryRow>(
        `
          WITH target_regions AS (
            SELECT rc.uid,
                   rc.region_type,
                   rc.title_uk AS region_title_uk,
                   CASE WHEN rc.region_type = 'raion' THEN rc.uid ELSE rc.raion_uid END AS group_raion_uid,
                   rr.title_uk AS raion_title_uk
            FROM region_catalog rc
            LEFT JOIN region_catalog rr ON rr.uid = rc.raion_uid
            WHERE rc.is_active = TRUE
              AND (rc.uid = $1 OR rc.oblast_uid = $1)
              AND rc.region_type IN ('raion', 'hromada', 'city')
          ),
          started_events AS (
            SELECT tr.uid,
                   tr.region_type,
                   tr.region_title_uk,
                 tr.group_raion_uid,
                   tr.raion_title_uk,
                   e.occurred_at,
                   COALESCE(e.alert_type, 'air_raid') AS alert_type
            FROM target_regions tr
            JOIN air_raid_events e ON e.uid = tr.uid
            WHERE e.event_kind = 'started'
              AND e.new_status = 'A'
              AND e.occurred_at >= (NOW() - INTERVAL '4 days')
          )
          SELECT se.uid,
                 se.region_type,
                 se.region_title_uk,
               se.group_raion_uid,
                 se.raion_title_uk,
                 se.occurred_at::text AS started_at,
                 NULLIF(
                   (
                     SELECT e2.occurred_at::text
                     FROM air_raid_events e2
                     WHERE e2.uid = se.uid
                       AND e2.event_kind = 'ended'
                       AND e2.occurred_at > se.occurred_at
                     ORDER BY e2.occurred_at ASC
                     LIMIT 1
                   ),
                   ''
                 ) AS ended_at,
                 se.alert_type
          FROM started_events se
          ORDER BY se.occurred_at DESC
          LIMIT 300
        `,
        [oblastUid],
      ),
      this.databaseService.query<RaionLeafCountRow>(
        `
          SELECT rr.uid AS raion_uid,
                 rr.title_uk AS raion_title_uk,
                 COUNT(rc.uid)::text AS total_leaf_count
          FROM region_catalog rr
          LEFT JOIN region_catalog rc
            ON rc.raion_uid = rr.uid
           AND rc.is_active = TRUE
           AND rc.region_type IN ('hromada', 'city')
          WHERE rr.is_active = TRUE
            AND rr.oblast_uid = $1
            AND rr.region_type = 'raion'
          GROUP BY rr.uid, rr.title_uk
        `,
        [oblastUid],
      ),
    ]);

    const formatKyivDate = (value: Date) =>
      new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Kyiv',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(value);

    const now = new Date(TimeUtil.getNowInKyiv());
    const todayIso = formatKyivDate(now);
    const yesterdayDate = new Date(now);
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yesterdayIso = formatKyivDate(yesterdayDate);

    const toHistoryItem = (row: {
      region_title_uk: string;
      raion_title_uk: string | null;
      started_at: string;
      ended_at?: string | null;
      alert_type: string;
    }) => {
      // Явно преобразуем пустые/whitespace strings в null
      const normalizedEndedAt =
        row.ended_at && typeof row.ended_at === 'string' && row.ended_at.trim().length > 0
          ? row.ended_at.trim()
          : null;

      return {
        region_title_uk: row.region_title_uk,
        raion_title_uk: row.raion_title_uk,
        started_at: row.started_at,
        ended_at: normalizedEndedAt,
        alert_type: row.alert_type,
      };
    };

    const areSameHistoryKey = (
      left: {
        region_title_uk: string;
        raion_title_uk: string | null;
        alert_type: string;
      },
      right: {
        region_title_uk: string;
        raion_title_uk: string | null;
        alert_type: string;
      },
    ) => (
      left.region_title_uk === right.region_title_uk
      && (left.raion_title_uk ?? null) === (right.raion_title_uk ?? null)
      && left.alert_type === right.alert_type
    );

    const parseTimestampMs = (value: string | null | undefined) => {
      if (!value) return null;
      const timestamp = new Date(value).getTime();
      return Number.isNaN(timestamp) ? null : timestamp;
    };

    const CONTIGUOUS_GAP_MS = 60 * 1000;

    const remainingEndedRows = endedResult.rows.filter((row) => !!row.ended_at);
    const mergedActiveRows = activeResult.rows.map((row) => {
      let mergedStartedAt = row.started_at;

      while (true) {
        const currentStartMs = parseTimestampMs(mergedStartedAt);
        if (currentStartMs == null) break;

        let matchedIndex = -1;
        let matchedGap = Number.MAX_SAFE_INTEGER;

        remainingEndedRows.forEach((endedRow, index) => {
          if (!areSameHistoryKey(row, endedRow)) {
            return;
          }

          const endedAtMs = parseTimestampMs(endedRow.ended_at);
          if (endedAtMs == null) {
            return;
          }

          const gapMs = currentStartMs - endedAtMs;
          if (gapMs < 0 || gapMs > CONTIGUOUS_GAP_MS) {
            return;
          }

          if (gapMs < matchedGap) {
            matchedGap = gapMs;
            matchedIndex = index;
          }
        });

        if (matchedIndex < 0) {
          break;
        }

        const matchedRow = remainingEndedRows.splice(matchedIndex, 1)[0];
        mergedStartedAt = matchedRow.started_at;
      }

      return {
        ...row,
        started_at: mergedStartedAt,
      };
    });

    const raionLeafCounts = new Map(
      raionLeafCountResult.rows.map((row) => [
        row.raion_uid,
        {
          title: row.raion_title_uk,
          total: Number(row.total_leaf_count),
        },
      ]),
    );

    const consolidateEndedRows = (rows: OblastEndedHistoryRow[]) => {
      const groupedRows = new Map<string, OblastEndedHistoryRow[]>();

      rows.forEach((row) => {
        const key = [row.started_at, row.ended_at ?? '', row.alert_type].join('|');
        const group = groupedRows.get(key) ?? [];
        group.push(row);
        groupedRows.set(key, group);
      });

      const consolidated: OblastEndedHistoryRow[] = [];

      groupedRows.forEach((group) => {
        const coveredRaions = new Set<number>();

        group
          .filter((row) => row.region_type === 'raion' && row.group_raion_uid != null)
          .forEach((row) => {
            coveredRaions.add(row.group_raion_uid as number);
            consolidated.push(row);
          });

        const rowsByRaion = new Map<number, OblastEndedHistoryRow[]>();

        group
          .filter((row) => row.region_type !== 'raion')
          .forEach((row) => {
            if (row.group_raion_uid == null) {
              consolidated.push(row);
              return;
            }

            if (coveredRaions.has(row.group_raion_uid)) {
              return;
            }

            const raionRows = rowsByRaion.get(row.group_raion_uid) ?? [];
            raionRows.push(row);
            rowsByRaion.set(row.group_raion_uid, raionRows);
          });

        rowsByRaion.forEach((raionRows, raionUid) => {
          const raionInfo = raionLeafCounts.get(raionUid);
          if (raionInfo && raionInfo.total > 0 && raionRows.length === raionInfo.total) {
            const template = raionRows[0];
            consolidated.push({
              ...template,
              uid: raionUid,
              region_type: 'raion',
              region_title_uk: raionInfo.title,
              raion_title_uk: null,
              group_raion_uid: raionUid,
            });
            return;
          }

          consolidated.push(...raionRows);
        });
      });

      return consolidated.sort(
        (left, right) => new Date(right.started_at).getTime() - new Date(left.started_at).getTime(),
      );
    };

    const active = mergedActiveRows.map((row) => toHistoryItem(row));
    const endedRows = consolidateEndedRows(remainingEndedRows);

    const today = endedRows
      .filter((row) => formatKyivDate(new Date(row.started_at)) === todayIso)
      .map((row) => toHistoryItem(row));

    const yesterday = endedRows
      .filter((row) => formatKyivDate(new Date(row.started_at)) === yesterdayIso)
      .map((row) => toHistoryItem(row));

    return { active, today, yesterday };
  }

  private buildDispatchText(
    dispatchKind: 'start' | 'end',
    labelUser: string | null,
    leafTitleUk: string | null,
    raionTitleUk: string | null,
    oblastTitleUk: string | null,
  ) {
    const regionName = this.resolveRegionName(labelUser, leafTitleUk, raionTitleUk, oblastTitleUk);
    const regionLine = regionName ? `${regionName}` : 'вибрана точка';

    if (dispatchKind === 'start') {
      return {
        title_uk: '🚨 Повітряна тривога!',
        body_uk: `${regionLine} — оголошено повітряну тривогу.`,
      };
    }

    return {
      title_uk: '✅ Відбій тривоги',
      body_uk: `${regionLine} — повітряна тривога скасована.`,
    };
  }

  private resolveRegionName(
    labelUser: string | null,
    leafTitleUk: string | null,
    raionTitleUk: string | null,
    oblastTitleUk: string | null,
  ): string | null {
    if (labelUser === 'Район') return raionTitleUk ?? leafTitleUk;
    if (labelUser === 'Область') return oblastTitleUk ?? raionTitleUk ?? leafTitleUk;
    // Default: hromada level (labelUser === 'Громада' or any custom label)
    return leafTitleUk;
  }

  private async loadAncestorTitles(
    executor: QueryExecutor,
    raionUid: number | null,
    oblastUid: number | null,
  ): Promise<{ raionTitle: string | null; oblastTitle: string | null }> {
    const uids = [raionUid, oblastUid].filter((u): u is number => u !== null);
    if (!uids.length) {
      return { raionTitle: null, oblastTitle: null };
    }
    const result = await this.queryWithExecutor<AncestorTitleRow>(
      executor,
      'SELECT uid, title_uk FROM region_catalog WHERE uid = ANY($1::int[])',
      [uids],
    );
    const byUid = new Map(result.rows.map((r) => [r.uid, r.title_uk]));
    return {
      raionTitle:  raionUid  ? (byUid.get(raionUid)  ?? null) : null,
      oblastTitle: oblastUid ? (byUid.get(oblastUid) ?? null) : null,
    };
  }

  private async resolvePointInternal(
    executor: QueryExecutor,
    latitude: number,
    longitude: number,
  ) {
    const result = await this.queryWithExecutor<ResolvedPointRow>(
      executor,
      `
        SELECT rc.uid AS leaf_uid,
               rc.region_type AS leaf_type,
               rc.title_uk AS leaf_title_uk,
               rc.raion_uid,
               rc.oblast_uid
        FROM region_geometry rg
        JOIN region_catalog rc ON rc.uid = rg.uid
        WHERE rc.is_active = TRUE
          AND rc.is_subscription_leaf = TRUE
          AND ST_Covers(rg.geom, ST_SetSRID(ST_MakePoint($1, $2), 4326))
        ORDER BY CASE WHEN rc.region_type = 'city' THEN 0 ELSE 1 END, rc.uid ASC
        LIMIT 1
      `,
      [longitude, latitude],
    );

    if (result.rowCount === 0) {
      throw new NotFoundException(
        'Не вдалося визначити громаду для обраної точки. Геометричні дані ще не завантажені або точка лежить поза підтримуваною територією.',
      );
    }

    return result.rows[0];
  }

  private async resolvePointWithDisplayContext(
    executor: QueryExecutor,
    latitude: number,
    longitude: number,
  ): Promise<ResolvedPointRow> {
    const point = await this.resolvePointInternal(executor, latitude, longitude);

    if (point.oblast_uid != null || point.leaf_type !== 'city' || !this.isKyivCityTitle(point.leaf_title_uk)) {
      return point;
    }

    const kyivOblastUid = await this.loadKyivOblastUid(executor);
    if (!kyivOblastUid) {
      return point;
    }

    return {
      ...point,
      oblast_uid: kyivOblastUid,
    };
  }

  private async loadKyivOblastUid(executor: QueryExecutor): Promise<number | null> {
    if (this.kyivOblastUidCache !== undefined) {
      return this.kyivOblastUidCache;
    }

    const result = await this.queryWithExecutor<{ uid: number }>(
      executor,
      `
        SELECT uid
        FROM region_catalog
        WHERE is_active = TRUE
          AND region_type = 'oblast'
          AND (title_uk = 'Київська область' OR title_uk ILIKE 'Київ%област%')
        ORDER BY CASE WHEN title_uk = 'Київська область' THEN 0 ELSE 1 END, uid ASC
        LIMIT 1
      `,
    );

    this.kyivOblastUidCache = result.rows[0]?.uid ?? null;
    return this.kyivOblastUidCache;
  }

  private isKyivCityTitle(titleUk: string): boolean {
    const normalized = titleUk
      .toLocaleLowerCase('uk-UA')
      .replace(/\./g, '')
      .replace(/^м\s+/u, '')
      .trim();
    return normalized === 'київ';
  }

  private async loadStateContext(
    executor: QueryExecutor,
    leafUid: number,
    raionUid: number | null,
    oblastUid: number | null,
  ) {
    const uids = [leafUid, raionUid, oblastUid].filter((uid): uid is number => uid !== null);
    const [statesResult, versionResult] = await Promise.all([
      this.queryWithExecutor<StateRow>(
        executor,
        `
          SELECT uid, status, active_from::text, state_version
          FROM air_raid_state_current
          WHERE uid = ANY($1::int[])
        `,
        [uids],
      ),
      this.queryWithExecutor<{ state_version: number }>(
        executor,
        'SELECT COALESCE(MAX(state_version), 0) AS state_version FROM air_raid_state_current',
      ),
    ]);

    return {
      stateVersion: Number(versionResult.rows[0]?.state_version ?? 0),
      statesByUid: new Map<number, StateRow>(
        statesResult.rows.map((row: StateRow) => [row.uid, row]),
      ),
    };
  }

  private async loadAggregateStatuses(
    executor: QueryExecutor,
    raionUid: number | null,
    oblastUid: number | null,
  ) {
    const result = await this.queryWithExecutor<AggregateStatusRow>(
      executor,
      `
        WITH targets AS (
          SELECT 'raion'::text AS level, $1::int AS uid
          WHERE $1 IS NOT NULL
          UNION ALL
          SELECT 'oblast'::text AS level, $2::int AS uid
          WHERE $2 IS NOT NULL
        ),
        coverage AS (
          SELECT
            t.level,
            t.uid,
            COUNT(leaf.uid)::int AS total_leaf_count,
            COUNT(*) FILTER (WHERE leaf_state.status = 'A')::int AS active_leaf_count
          FROM targets t
          JOIN region_catalog leaf ON leaf.is_active = TRUE
            AND leaf.is_subscription_leaf = TRUE
            AND (
              (t.level = 'raion' AND leaf.raion_uid = t.uid)
              OR
              (t.level = 'oblast' AND leaf.oblast_uid = t.uid)
            )
          LEFT JOIN air_raid_state_current leaf_state ON leaf_state.uid = leaf.uid
          GROUP BY t.level, t.uid
        )
        SELECT
          level,
          uid,
          CASE
            WHEN total_leaf_count = 0 THEN ' '
            WHEN active_leaf_count = 0 THEN 'N'
            WHEN active_leaf_count = total_leaf_count THEN 'A'
            ELSE 'P'
          END::text AS status
        FROM coverage
      `,
      [raionUid, oblastUid],
    );

    const byLevel = new Map(result.rows.map((row) => [row.level, row.status]));
    return {
      raionStatus: byLevel.get('raion') ?? null,
      oblastStatus: byLevel.get('oblast') ?? null,
    };
  }

  private resolveSubscriptionScope(labelUser: string | null | undefined): SubscriptionScope {
    if (labelUser === 'Район') {
      return 'raion';
    }

    if (labelUser === 'Область') {
      return 'oblast';
    }

    return 'hromada';
  }

  private resolveScopeTargetUid(source: ScopedSubscriptionSource) {
    switch (this.resolveSubscriptionScope(source.label_user)) {
      case 'oblast':
        return source.oblast_uid ?? source.raion_uid ?? source.leaf_uid;
      case 'raion':
        return source.raion_uid ?? source.leaf_uid ?? source.oblast_uid;
      default:
        return source.leaf_uid ?? source.raion_uid ?? source.oblast_uid;
    }
  }

  private normalizeRuntimeForScope(
    source: ScopedSubscriptionSource,
    previousRuntime: RuntimeRow,
    nextRuntime: EffectiveState,
  ): RuntimeRow {
    const targetUid = this.resolveScopeTargetUid(source);

    if (previousRuntime.effective_uid === null || previousRuntime.effective_uid === targetUid) {
      return previousRuntime;
    }

    return {
      ...previousRuntime,
      effective_status: nextRuntime.effective_status,
      effective_uid: nextRuntime.effective_uid,
      effective_started_at: nextRuntime.effective_started_at,
    };
  }

  private evaluateEffectiveState(
    source: ScopedSubscriptionSource,
    statesByUid: Map<number, Pick<StateRow, 'status' | 'active_from'>>,
  ): EffectiveState {
    const targetUid = this.resolveScopeTargetUid(source);
    if (targetUid === null) {
      return {
        effective_status: ' ',
        effective_uid: null,
        effective_started_at: null,
      };
    }

    const state = statesByUid.get(targetUid);
    if (!state) {
      return {
        effective_status: ' ',
        effective_uid: null,
        effective_started_at: null,
      };
    }

    if (ACTIVE_STATUSES.has(state.status)) {
      return {
        effective_status: state.status,
        effective_uid: targetUid,
        effective_started_at: state.active_from,
      };
    }

    if (state.status !== ' ') {
      return {
        effective_status: state.status,
        effective_uid: null,
        effective_started_at: null,
      };
    }

    return {
      effective_status: ' ',
      effective_uid: null,
      effective_started_at: null,
    };
  }

  private getStatusLabelUk(status: AlertStatus) {
    switch (status) {
      case 'A':
        return 'Повітряна тривога';
      case 'P':
        return 'Часткова повітряна тривога';
      case 'N':
        return 'Немає тривоги';
      default:
        return 'Немає даних';
    }
  }

  private buildAddressLabel(leafTitleUk: string) {
    return `Точка в межах «${leafTitleUk}»`;
  }

  private toSubscriptionSyncPayload(view: SubscriptionViewRow) {
    return {
      subscription_id: view.subscription_id,
      installation_id: view.installation_id,
      label_user: view.label_user,
      address_uk: view.address_uk,
      latitude: view.latitude,
      longitude: view.longitude,
      leaf_uid: view.leaf_uid,
      raion_uid: view.raion_uid,
      oblast_uid: view.oblast_uid,
      notify_on_start: view.notify_on_start,
      notify_on_end: view.notify_on_end,
      is_active: view.is_active,
      created_at: view.created_at,
      updated_at: view.updated_at,
    };
  }

  private async getSubscriptionViewsByInstallation(installationId: string) {
    const result = await this.databaseService.query<SubscriptionViewRow>(
      `
        SELECT s.subscription_id,
               s.installation_id,
               s.label_user,
               s.address_uk,
               s.latitude,
               s.longitude,
               s.leaf_uid,
               s.raion_uid,
               s.oblast_uid,
               leaf.title_uk AS leaf_title_uk,
               s.notify_on_start,
               s.notify_on_end,
               s.is_active,
               COALESCE(srs.effective_status, ' ') AS current_status,
               s.created_at::text,
               s.updated_at::text
        FROM subscriptions s
        LEFT JOIN region_catalog leaf ON leaf.uid = s.leaf_uid
        LEFT JOIN subscription_runtime_state srs ON srs.subscription_id = s.subscription_id
        WHERE s.installation_id = $1
        ORDER BY s.created_at ASC
      `,
      [installationId],
    );

    return result.rows;
  }

  private async getOwnedSubscriptionView(
    executor: QueryExecutor,
    installationId: string,
    subscriptionId: string,
  ) {
    const result = await this.queryWithExecutor<SubscriptionViewRow>(
      executor,
      `
        SELECT s.subscription_id,
               s.installation_id,
               s.label_user,
               s.address_uk,
               s.latitude,
               s.longitude,
               s.leaf_uid,
               s.raion_uid,
               s.oblast_uid,
               leaf.title_uk AS leaf_title_uk,
               s.notify_on_start,
               s.notify_on_end,
               s.is_active,
               COALESCE(srs.effective_status, ' ') AS current_status,
               s.created_at::text,
               s.updated_at::text
        FROM subscriptions s
        LEFT JOIN region_catalog leaf ON leaf.uid = s.leaf_uid
        LEFT JOIN subscription_runtime_state srs ON srs.subscription_id = s.subscription_id
        WHERE s.subscription_id = $1
          AND s.installation_id = $2
        LIMIT 1
      `,
      [subscriptionId, installationId],
    );

    if (result.rowCount === 0) {
      throw new NotFoundException('Підписку не знайдено.');
    }

    return result.rows[0];
  }

  private ensureDatabaseConfigured() {
    if (!this.databaseService.isConfigured()) {
      throw new Error('DATABASE_URL is not configured.');
    }
  }

  private queryWithExecutor<T extends QueryResultRow>(
    executor: QueryExecutor,
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<T>> {
    return (executor as DatabaseService).query<T>(text, values);
  }
}
