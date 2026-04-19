import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../common/database/database.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';

type AlertStatus = 'A' | 'P' | 'N' | ' ';
type AlertType = 'air_raid' | 'artillery_shelling' | 'urban_fights' | 'chemical' | 'nuclear';

type ParseCandidate = {
  threat_kind: 'uav' | 'kab' | 'missile' | 'unknown';
  confidence: number;
  region_hint: string | null;
  origin_hint: string | null;
  target_hint: string | null;
  direction_text: string | null;
  origin_lat: number | null;
  origin_lng: number | null;
  target_lat: number | null;
  target_lng: number | null;
  movement_bearing_deg: number | null;
};

type PendingJobRow = {
  job_id: string;
  raw_message_id: string;
  message_text: string;
  message_date: string;
};

type RegionPoint = {
  uid: number;
  title_uk: string;
  latitude: number;
  longitude: number;
};

type ThreatVectorDedupeKeyInput = {
  rawMessageId: string;
  threatKind: ParseCandidate['threat_kind'];
  regionHint: string | null;
  originHint: string | null;
  targetHint: string | null;
  directionText: string | null;
  originUid: number | null;
  targetUid: number | null;
  originLat: number | null;
  originLng: number | null;
  targetLat: number | null;
  targetLng: number | null;
};

export function buildGeminiThreatPrompt(messageText: string) {
  return [
    'Extract threats from Ukrainian military alert posts.',
    'Geographical context:',
    '- Threats (KAB, UAV, missiles) typically arrive from RF/Belarus (North, East, North-East) or the Black Sea (South).',
    '- Combine context from multiple lines if they describe the same event. (e.g., "Active aviation in north-east! KAB launches to Kharkiv" = 1 KAB threat towards Kharkiv originating from north-east).',
    '- If one post describes several simultaneous threats, return one threat object per independently trackable threat.',
    '- region_hint must describe the threat\'s current location now. target_hint must describe only where it is heading. Never replace the current location with a destination unless the post explicitly says the threat is already there.',
    '- If the same threat kind is reported in multiple current locations with one shared course/target, split it into separate threat objects by current location.',
    '- Example: "🛵 БпЛА на Сумщині і Харківщині курсом на Полтавщину." = 2 UAV threats: (1) current location Sumy region -> target Poltava region; (2) current location Kharkiv region -> target Poltava region.',
    '- For each split object, keep the shared target_hint and direction_text the same, but set region_hint to the specific current location. If no earlier launch point is given, origin_hint may repeat that same current location.',
    '- If the same threat kind is reported in one current location with multiple targets/courses, split it into separate threat objects by target while keeping the same current location in region_hint.',
    '- Example: "🛵 Група БпЛА на Сумщині курсом на Полтавщину та Харківщину." = 2 UAV threats: (1) current location Sumy region -> target Poltava region; (2) current location Sumy region -> target Kharkiv region.',
    '- For each split object in that case, keep region_hint and origin_hint as the shared current location, but set target_hint and direction_text to the specific destination for that object.',
    '- Do not merge different current locations into one threat object.',
    '- "БпЛА на півночі Чернігівщини, курс південний" means current location is North Chernihiv region, and movement_bearing_deg is South (180).',
    '- Directions to bearings: North = 0, North-East = 45, East = 90, South-East = 135, South = 180, South-West = 225, West = 270, North-West = 315.',
    'Return strict JSON only with this schema:',
    '{"threats":[{"threat_kind":"uav|kab|missile|unknown","confidence":0.0,"region_hint":"string|null","origin_hint":"string|null","target_hint":"string|null","direction_text":"string|null","origin_lat":0.0,"origin_lng":0.0,"target_lat":0.0,"target_lng":0.0,"movement_bearing_deg":0.0}]}',
    'Coordinates must be WGS84 decimal degrees.',
    'If exact coordinates are unknown, provide approximate settlement/raion center coordinates.',
    'If no reliable coordinates or bearing can be extracted, use null for those fields. DO NOT use 0 as fallback.',
    'No markdown, no comments, no extra keys.',
    `Text: ${messageText}`,
  ].join('\n');
}

export function buildThreatVectorDedupeKey(params: ThreatVectorDedupeKeyInput) {
  const normalizeText = (value: string | null) => value?.trim().toLowerCase().replace(/\s+/g, ' ') ?? '';
  const formatCoords = (lat: number | null, lng: number | null) =>
    lat !== null && lng !== null ? `${lat.toFixed(4)},${lng.toFixed(4)}` : '';

  return createHash('sha256')
    .update(
      [
        params.rawMessageId,
        params.threatKind,
        params.originUid ?? 'unknown',
        formatCoords(params.originLat, params.originLng),
        normalizeText(params.originHint ?? params.regionHint),
        params.targetUid ?? 'unknown',
        formatCoords(params.targetLat, params.targetLng),
        normalizeText(params.targetHint ?? params.regionHint),
        normalizeText(params.directionText),
      ].join(':'),
    )
    .digest('hex');
}

export function getThreatTtlMinutes(threatKind: 'uav' | 'kab' | 'missile' | 'unknown') {
  const baseTtlMinutes =
    threatKind === 'uav' ? 180 : threatKind === 'kab' ? 40 : threatKind === 'missile' ? 35 : 45;

  return Math.min(baseTtlMinutes, 120);
}

@Injectable()
export class GeminiThreatParserService {
  private readonly logger = new Logger(GeminiThreatParserService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly databaseService: DatabaseService,
    private readonly subscriptionsService: SubscriptionsService,
  ) {}

  async processPendingJobs() {
    if (!this.databaseService.isConfigured()) {
      throw new Error('DATABASE_URL is not configured.');
    }

    const batchSize = this.getNumberEnv('TELEGRAM_PARSER_BATCH', 20);
    const maxAttempts = this.getNumberEnv('TELEGRAM_PARSER_MAX_ATTEMPTS', 3);
    const pendingJobs = await this.pickJobs(batchSize, maxAttempts);

    if (pendingJobs.length === 0) {
      return {
        picked_jobs: 0,
        successful_jobs: 0,
        failed_jobs: 0,
        overlays_created: 0,
      };
    }

    let successfulJobs = 0;
    let failedJobs = 0;
    let overlaysCreated = 0;

    for (const job of pendingJobs) {
      try {
        const attemptCount = await this.markJobProcessing(job.job_id);
        
        const lowerText = job.message_text.toLowerCase();
        if (lowerText.includes('відбій') || lowerText.includes('збито') || lowerText.includes('подавлено')) {
          await this.markJobSuccess(job.job_id); // we mark as success to not re-parse
          successfulJobs += 1;
          continue;
        }

        const candidates = await this.parseWithGemini(job.job_id, attemptCount, job.message_text);

        if (candidates.length === 0) {
          await this.markJobFailed(job.job_id, 'No candidates were extracted by parser.', true);
          failedJobs += 1;
          continue;
        }

        const persistResult = await this.databaseService.withTransaction(async (client) => {
          return this.persistCandidates(client, job, candidates);
        });

        overlaysCreated += persistResult.overlays_created;
        await this.markJobSuccess(job.job_id);
        successfulJobs += 1;
      } catch (error) {
        failedJobs += 1;
        await this.markJobFailed(job.job_id, this.stringifyError(error), false);
      }
    }

    return {
      picked_jobs: pendingJobs.length,
      successful_jobs: successfulJobs,
      failed_jobs: failedJobs,
      overlays_created: overlaysCreated,
    };
  }

  private async pickJobs(batchSize: number, maxAttempts: number) {
    const result = await this.databaseService.query<PendingJobRow>(
      `
        SELECT lpj.job_id,
               lpj.raw_message_id::text,
               tmr.message_text,
               tmr.message_date::text
        FROM llm_parse_jobs lpj
        JOIN telegram_messages_raw tmr ON tmr.raw_message_id = lpj.raw_message_id
        WHERE lpj.status IN ('pending', 'failed')
          AND lpj.attempt_count < $1
        ORDER BY lpj.created_at ASC
        LIMIT $2
      `,
      [maxAttempts, batchSize],
    );

    return result.rows;
  }

  private async markJobProcessing(jobId: string) {
    const result = await this.databaseService.query<{ attempt_count: number }>(
      `
        UPDATE llm_parse_jobs
        SET status = 'processing',
            attempt_count = attempt_count + 1,
            started_at = NOW(),
            updated_at = NOW(),
            last_error = NULL
        WHERE job_id = $1
        RETURNING attempt_count
      `,
      [jobId],
    );

    return Number(result.rows[0]?.attempt_count ?? 1);
  }

  private async markJobSuccess(jobId: string) {
    await this.databaseService.query(
      `
        UPDATE llm_parse_jobs
        SET status = 'success',
            processed_at = NOW(),
            updated_at = NOW(),
            last_error = NULL
        WHERE job_id = $1
      `,
      [jobId],
    );
  }

  private async markJobFailed(jobId: string, errorMessage: string, manualReview: boolean) {
    await this.databaseService.query(
      `
        UPDATE llm_parse_jobs
        SET status = $2,
            processed_at = NOW(),
            updated_at = NOW(),
            last_error = LEFT($3, 2000)
        WHERE job_id = $1
      `,
      [jobId, manualReview ? 'manual_review' : 'failed', errorMessage],
    );
  }

  private async parseWithGemini(jobId: string, attemptCount: number, messageText: string) {
    const apiKey = this.configService.get<string>('GEMINI_API_KEY');
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is not configured.');
    }

    const model = this.configService.get<string>('GEMINI_MODEL') ?? 'gemini-3-flash-preview';
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const prompt = buildGeminiThreatPrompt(messageText);

    const requestPayload = {
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: 'application/json',
      },
    };

    this.logger.log(
      `LLM request model=${model} payload=${JSON.stringify(requestPayload)}`,
    );

    const requestPayloadJson = JSON.stringify(requestPayload);

    let responseStatus: number | null = null;
    let responseBody = '';
    let parsedCandidates: ParseCandidate[] = [];
    let parseErrorText: string | null = null;

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: requestPayloadJson,
        signal: AbortSignal.timeout(this.getNumberEnv('GEMINI_TIMEOUT_MS', 30000)),
      });

      responseStatus = response.status;
      responseBody = await response.text();
      this.logger.log(`LLM response status=${response.status} body=${responseBody}`);

      if (!response.ok) {
        throw new Error(`Gemini request failed: HTTP ${response.status} ${responseBody}`);
      }

      const parsedBody = JSON.parse(responseBody) as {
        candidates?: Array<{
          content?: {
            parts?: Array<{ text?: string }>;
          };
        }>;
      };

      const textPayload = parsedBody.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      const jsonPayload = this.unwrapJson(textPayload);
      const decoded = JSON.parse(jsonPayload) as { threats?: ParseCandidate[] };
      parsedCandidates = decoded.threats ?? [];

      this.logger.log(`LLM parsed candidates=${JSON.stringify(parsedCandidates)}`);

      return parsedCandidates
        .map((item) => this.sanitizeCandidate(item))
        .filter((item): item is ParseCandidate => item !== null);
    } catch (error) {
      parseErrorText = this.stringifyError(error);
      throw error;
    } finally {
      await this.persistLlmExchange({
        jobId,
        attemptCount,
        model,
        requestPayloadJson,
        responseStatus,
        responseBody,
        parsedCandidates,
        errorText: parseErrorText,
      });
    }
  }

  private async persistLlmExchange(params: {
    jobId: string;
    attemptCount: number;
    model: string;
    requestPayloadJson: string;
    responseStatus: number | null;
    responseBody: string;
    parsedCandidates: ParseCandidate[];
    errorText: string | null;
  }) {
    try {
      await this.databaseService.query(
        `
          INSERT INTO llm_request_response_audit (
            audit_id,
            job_id,
            attempt_count,
            model,
            request_payload,
            response_status,
            response_body,
            parsed_candidates,
            error_text,
            created_at
          ) VALUES (
            $1,
            $2,
            $3,
            $4,
            $5::jsonb,
            $6,
            $7,
            $8::jsonb,
            $9,
            NOW()
          )
        `,
        [
          randomUUID(),
          params.jobId,
          params.attemptCount,
          params.model,
          params.requestPayloadJson,
          params.responseStatus,
          params.responseBody,
          JSON.stringify(params.parsedCandidates),
          params.errorText,
        ],
      );
    } catch (error) {
      this.logger.warn(`Failed to persist LLM audit for job ${params.jobId}: ${this.stringifyError(error)}`);
    }
  }

  private sanitizeCandidate(candidate: ParseCandidate | null | undefined) {
    if (!candidate) {
      return null;
    }

    const threatKind = this.normalizeThreatKind(candidate.threat_kind);
    const confidence = Math.max(0, Math.min(1, Number(candidate.confidence ?? 0)));

    return {
      threat_kind: threatKind,
      confidence,
      region_hint: this.toNullableString(candidate.region_hint),
      origin_hint: this.toNullableString(candidate.origin_hint),
      target_hint: this.toNullableString(candidate.target_hint),
      direction_text: this.toNullableString(candidate.direction_text),
      origin_lat: this.toLatitude(candidate.origin_lat),
      origin_lng: this.toLongitude(candidate.origin_lng),
      target_lat: this.toLatitude(candidate.target_lat),
      target_lng: this.toLongitude(candidate.target_lng),
      movement_bearing_deg: this.toBearing(candidate.movement_bearing_deg),
    };
  }

  private async persistCandidates(
    client: PoolClient,
    job: PendingJobRow,
    candidates: ParseCandidate[],
  ) {
    let overlaysCreated = 0;

    for (const candidate of candidates) {
      const fallbackHint = candidate.region_hint;
      const origin = await this.resolveRegionHint(client, candidate.origin_hint ?? fallbackHint);
      const target = await this.resolveRegionHint(client, candidate.target_hint ?? fallbackHint);

      const originLat = candidate.origin_lat ?? origin?.latitude ?? null;
      const originLng = candidate.origin_lng ?? origin?.longitude ?? null;
      const targetLat = candidate.target_lat ?? target?.latitude ?? null;
      const targetLng = candidate.target_lng ?? target?.longitude ?? null;

      const bearing =
        candidate.movement_bearing_deg ??
        (originLat !== null && originLng !== null && targetLat !== null && targetLng !== null
          ? this.calculateBearing(originLat, originLng, targetLat, targetLng)
          : null);

      const occurredAt = new Date(job.message_date);
      const expiresAt = this.estimateExpiry(occurredAt, candidate.threat_kind);
      const vectorId = randomUUID();
      const dedupeKey = buildThreatVectorDedupeKey({
        rawMessageId: job.raw_message_id,
        threatKind: candidate.threat_kind,
        regionHint: candidate.region_hint,
        originHint: candidate.origin_hint,
        targetHint: candidate.target_hint,
        directionText: candidate.direction_text,
        originUid: origin?.uid ?? null,
        targetUid: target?.uid ?? null,
        originLat,
        originLng,
        targetLat,
        targetLng,
      });

      const insertVector = await client.query<{ inserted: number }>(
        `
          INSERT INTO threat_vectors (
            vector_id,
            raw_message_id,
            job_id,
            threat_kind,
            confidence,
            region_hint,
            origin_hint,
            target_hint,
            direction_text,
            origin_uid,
            target_uid,
            origin_geom,
            target_geom,
            corridor_geom,
            danger_area_geom,
            movement_bearing_deg,
            icon_type,
            color_hex,
            occurred_at,
            expires_at,
            parsed_payload,
            normalized_dedupe_key,
            created_at
          ) VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            $9,
            $10,
            $11,
            CASE WHEN $12::double precision IS NULL OR $13::double precision IS NULL THEN NULL ELSE ST_SetSRID(ST_MakePoint($13, $12), 4326) END,
            CASE WHEN $14::double precision IS NULL OR $15::double precision IS NULL THEN NULL ELSE ST_SetSRID(ST_MakePoint($15, $14), 4326) END,
            CASE
              WHEN $12::double precision IS NOT NULL AND $13::double precision IS NOT NULL AND $14::double precision IS NOT NULL AND $15::double precision IS NOT NULL
                THEN ST_MakeLine(
                  ST_SetSRID(ST_MakePoint($13, $12), 4326),
                  ST_SetSRID(ST_MakePoint($15, $14), 4326)
                )
              ELSE NULL
            END,
            CASE
              WHEN $14::double precision IS NOT NULL AND $15::double precision IS NOT NULL
                THEN ST_Buffer(ST_SetSRID(ST_MakePoint($15, $14), 4326)::geography, 20000)::geometry
              WHEN $12::double precision IS NOT NULL AND $13::double precision IS NOT NULL
                THEN ST_Buffer(ST_SetSRID(ST_MakePoint($13, $12), 4326)::geography, 25000)::geometry
              ELSE NULL
            END,
            $16,
            $17,
            $18,
            $19,
            $20,
            $21::jsonb,
            $22,
            NOW()
          )
          ON CONFLICT (normalized_dedupe_key) DO NOTHING
          RETURNING 1 AS inserted
        `,
        [
          vectorId,
          job.raw_message_id,
          job.job_id,
          candidate.threat_kind,
          candidate.confidence,
          candidate.region_hint,
          candidate.origin_hint,
          candidate.target_hint,
          candidate.direction_text,
          origin?.uid ?? null,
          target?.uid ?? null,
          originLat,
          originLng,
          targetLat,
          targetLng,
          bearing,
          this.toIconType(candidate.threat_kind),
          this.toColor(candidate.threat_kind),
          occurredAt.toISOString(),
          expiresAt.toISOString(),
          JSON.stringify(candidate),
          dedupeKey,
        ],
      );

      if (insertVector.rowCount === 0) {
        continue;
      }

      await client.query(
        `
          INSERT INTO threat_visual_overlays (
            overlay_id,
            vector_id,
            status,
            render_priority,
            created_at,
            updated_at
          ) VALUES ($1, $2, 'active', $3, NOW(), NOW())
          ON CONFLICT (vector_id) DO UPDATE
          SET status = 'active',
              render_priority = EXCLUDED.render_priority,
              updated_at = NOW()
        `,
        [randomUUID(), vectorId, this.toPriority(candidate.threat_kind)],
      );

      const runtimeEventId = await this.applyThreatVectorToRuntime(
        client,
        target?.uid ?? origin?.uid ?? null,
        candidate,
        occurredAt,
      );

      if (runtimeEventId) {
        await client.query(
          `
            UPDATE threat_vectors
            SET resolved_air_raid_event_id = $2
            WHERE vector_id = $1
          `,
          [vectorId, runtimeEventId],
        );
      }

      overlaysCreated += 1;
    }

    return {
      overlays_created: overlaysCreated,
    };
  }

  private async resolveRegionHint(client: PoolClient, hint: string | null) {
    const value = this.toNullableString(hint);
    if (!value) {
      return null;
    }

    const variants = this.buildRegionHintVariants(value);
    if (variants.length === 0) {
      return null;
    }

    const result = await client.query<RegionPoint>(
      `
        SELECT rc.uid,
               rc.title_uk,
               ST_Y(ST_Centroid(rg.geom)) AS latitude,
               ST_X(ST_Centroid(rg.geom)) AS longitude
        FROM region_catalog rc
        JOIN region_geometry rg ON rg.uid = rc.uid
        WHERE rc.is_active = TRUE
          AND EXISTS (
            SELECT 1
            FROM unnest($1::text[]) AS hint_variant
            WHERE rc.title_uk ILIKE ('%' || hint_variant || '%')
          )
        ORDER BY
          CASE rc.region_type
            WHEN 'oblast' THEN 0
            WHEN 'raion' THEN 1
            WHEN 'city' THEN 2
            WHEN 'hromada' THEN 3
            ELSE 4
          END,
          CHAR_LENGTH(rc.title_uk) ASC,
          rc.uid
        LIMIT 1
      `,
      [variants],
    );

    return result.rows[0] ?? null;
  }

  private buildRegionHintVariants(rawHint: string) {
    const values = new Set<string>();
    const push = (candidate: string) => {
      const cleaned = candidate
        .replace(/['"`]/g, ' ')
        .replace(/[.,:;!?()\[\]{}]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      if (cleaned.length >= 3) {
        values.add(cleaned);
      }
    };

    const source = rawHint.trim();
    push(source);

    const latinToCyrillic: Array<[RegExp, string]> = [
      [/chernihiv/gi, 'Чернігів'],
      [/mykolaiv/gi, 'Миколаїв'],
      [/dnipropetrovsk/gi, 'Дніпропетров'],
      [/zaporizhzhia|zaporozhye|zaporizhia/gi, 'Запоріж'],
      [/odesa|odessa/gi, 'Одеса'],
      [/sumy/gi, 'Суми'],
      [/kharkiv/gi, 'Харків'],
      [/donetsk/gi, 'Донецьк'],
      [/nova\s+odesa/gi, 'Новоодеса'],
      [/region|oblast/gi, 'область'],
      [/district|raion/gi, 'район'],
    ];

    let translated = source;
    for (const [pattern, replacement] of latinToCyrillic) {
      translated = translated.replace(pattern, replacement);
    }
    push(translated);

    const normalized = translated
      .replace(/\b(напрямок|курс|на\s+півночі|на\s+півдні|на\s+заході|на\s+сході|північний|південний|західний|східний)\b/gi, ' ')
      .replace(/\b(область|район|region|oblast|raion|district)\b/gi, ' ')
      .replace(/\b(н\.п\.|м\.)\s*/gi, ' ')
      .replace(/щин(а|і|у|ою)?/gi, '')
      .replace(/ськ(а|ої|ій|у|е|ому|их)?/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    push(normalized);

    if (/нова\s+одеса/i.test(translated)) {
      push('Новоодесь');
      push('Нова Одеса');
    }

    const words = normalized.split(' ').filter((word) => word.length >= 4);
    words.forEach((word) => push(word));

    return Array.from(values);
  }

  private normalizeThreatKind(value: string | null | undefined): ParseCandidate['threat_kind'] {
    const normalized = (value ?? '').toLowerCase();
    if (normalized.includes('uav') || normalized.includes('drone') || normalized.includes('бпла')) {
      return 'uav';
    }
    if (normalized.includes('kab') || normalized.includes('каб')) {
      return 'kab';
    }
    if (normalized.includes('missile') || normalized.includes('ракет')) {
      return 'missile';
    }
    return 'unknown';
  }

  private async applyThreatVectorToRuntime(
    client: PoolClient,
    targetUid: number | null,
    candidate: ParseCandidate,
    occurredAt: Date,
  ) {
    if (!targetUid || candidate.confidence < 0.6) {
      return null;
    }

    const stateRowResult = await client.query<{
      status: AlertStatus;
      state_version: number;
      active_from: string | null;
    }>(
      `
        SELECT status,
               state_version,
               active_from::text
        FROM air_raid_state_current
        WHERE uid = $1
        FOR UPDATE
      `,
      [targetUid],
    );

    const currentState = stateRowResult.rows[0] ?? {
      status: ' ' as AlertStatus,
      state_version: 0,
      active_from: null,
    };

    if (currentState.status === 'A' || currentState.status === 'P') {
      return null;
    }

    const stateVersionResult = await client.query<{ next_version: number }>(
      'SELECT COALESCE(MAX(state_version), 0) + 1 AS next_version FROM air_raid_state_current',
    );
    const nextStateVersion = Number(stateVersionResult.rows[0]?.next_version ?? 1);
    const syntheticCycleResult = await client.query<{ cycle_id: number }>(
      `
        INSERT INTO alert_poll_cycles (
          requested_at,
          finished_at,
          http_status,
          if_modified_since_sent,
          last_modified_received,
          status_string_hash,
          changed,
          error_code,
          error_message
        ) VALUES (
          $1,
          $1,
          200,
          NULL,
          NULL,
          NULL,
          TRUE,
          'telegram_llm',
          NULL
        )
        RETURNING cycle_id
      `,
      [occurredAt.toISOString()],
    );
    const sourceCycleId = Number(syntheticCycleResult.rows[0]?.cycle_id);
    const nextAlertType = this.toAlertType(candidate.threat_kind);
    const eventId = randomUUID();
    const dedupeKey = createHash('sha256')
      .update(['telegram', String(targetUid), nextAlertType, occurredAt.toISOString()].join(':'))
      .digest('hex');

    await client.query(
      `
        INSERT INTO air_raid_state_current (
          uid,
          status,
          alert_type,
          active_from,
          state_version,
          source_cycle_id,
          updated_at
        ) VALUES ($1, 'A', $2, $3, $4, $5, $3)
        ON CONFLICT (uid) DO UPDATE
        SET status = EXCLUDED.status,
            alert_type = EXCLUDED.alert_type,
            active_from = EXCLUDED.active_from,
            state_version = EXCLUDED.state_version,
            source_cycle_id = EXCLUDED.source_cycle_id,
            updated_at = EXCLUDED.updated_at
      `,
      [targetUid, nextAlertType, occurredAt.toISOString(), nextStateVersion, sourceCycleId],
    );

    const insertedEvent = await client.query(
      `
        INSERT INTO air_raid_events (
          event_id,
          uid,
          event_kind,
          previous_status,
          new_status,
          alert_type,
          occurred_at,
          state_version,
          source_cycle_id,
          dedupe_key
        ) VALUES ($1, $2, 'started', $3, 'A', $4, $5, $6, $7, $8)
        ON CONFLICT (dedupe_key) DO NOTHING
        RETURNING event_id
      `,
      [
        eventId,
        targetUid,
        currentState.status,
        nextAlertType,
        occurredAt.toISOString(),
        nextStateVersion,
        sourceCycleId,
        dedupeKey,
      ],
    );

    if (insertedEvent.rowCount === 0) {
      return null;
    }

    await this.subscriptionsService.synchronizeRuntimeState(client, {
      state_version: nextStateVersion,
      occurred_at: occurredAt,
    });

    return eventId;
  }

  private toAlertType(threatKind: ParseCandidate['threat_kind']): AlertType {
    switch (threatKind) {
      case 'kab':
        return 'artillery_shelling';
      case 'missile':
      case 'uav':
      case 'unknown':
      default:
        return 'air_raid';
    }
  }

  private toIconType(threatKind: ParseCandidate['threat_kind']) {
    switch (threatKind) {
      case 'uav':
        return 'drone';
      case 'kab':
        return 'bomb';
      case 'missile':
        return 'missile';
      default:
        return 'warning';
    }
  }

  private toColor(threatKind: ParseCandidate['threat_kind']) {
    switch (threatKind) {
      case 'uav':
        return '#f59e0b';
      case 'kab':
        return '#ef4444';
      case 'missile':
        return '#dc2626';
      default:
        return '#6b7280';
    }
  }

  private toPriority(threatKind: ParseCandidate['threat_kind']) {
    switch (threatKind) {
      case 'missile':
        return 10;
      case 'kab':
        return 20;
      case 'uav':
        return 30;
      default:
        return 90;
    }
  }

  private estimateExpiry(occurredAt: Date, threatKind: ParseCandidate['threat_kind']) {
    const ttlMinutes = getThreatTtlMinutes(threatKind);
    return new Date(occurredAt.getTime() + ttlMinutes * 60_000);
  }

  private calculateBearing(lat1: number, lon1: number, lat2: number, lon2: number) {
    const toRad = (value: number) => (value * Math.PI) / 180;
    const toDeg = (value: number) => (value * 180) / Math.PI;

    const phi1 = toRad(lat1);
    const phi2 = toRad(lat2);
    const deltaLambda = toRad(lon2 - lon1);

    const y = Math.sin(deltaLambda) * Math.cos(phi2);
    const x =
      Math.cos(phi1) * Math.sin(phi2) -
      Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);

    const theta = toDeg(Math.atan2(y, x));
    return (theta + 360) % 360;
  }

  private unwrapJson(payload: string) {
    const trimmed = payload.trim();
    if (trimmed.startsWith('```')) {
      return trimmed
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/```$/i, '')
        .trim();
    }

    return trimmed;
  }

  private toNullableString(value: string | null | undefined) {
    const cleaned = value?.trim();
    return cleaned ? cleaned : null;
  }

  private toLatitude(value: unknown) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed === 0 || parsed < -90 || parsed > 90) {
      return null;
    }
    return parsed;
  }

  private toLongitude(value: unknown) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed === 0 || parsed < -180 || parsed > 180) {
      return null;
    }
    return parsed;
  }

  private toBearing(value: unknown) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return null;
    }
    const normalized = parsed % 360;
    return normalized < 0 ? normalized + 360 : normalized;
  }

  private stringifyError(error: unknown) {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }

  private getNumberEnv(name: string, fallback: number) {
    const raw = this.configService.get<string>(name);
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return fallback;
    }

    return parsed;
  }
}
