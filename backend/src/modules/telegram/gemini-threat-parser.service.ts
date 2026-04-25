import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../common/database/database.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';

type AlertStatus = 'A' | 'P' | 'N' | ' ';
type AlertType = 'air_raid' | 'artillery_shelling' | 'urban_fights' | 'chemical' | 'nuclear';

type ParseCandidate = {
  action: 'new' | 'update' | 'clear';
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

type LlmTarget = {
  provider: 'grok' | 'gemini';
  model: string;
  apiKey: string;
};

const REGION_HINT_STOP_WORDS = new Set(['область', 'район', 'region', 'oblast', 'raion', 'district']);

// NEW: Add directional words that should never match as standalone region names
const DIRECTIONAL_STOP_WORDS = new Set([
  'схід', 'захід', 'північ', 'південь',
  'східний', 'західний', 'північний', 'південний',
  'східна', 'західна', 'північна', 'південна',
  'східне', 'західне', 'північне', 'південне',
  'східні', 'західні', 'північні', 'південні',
  'на сході', 'на заході', 'на півночі', 'на півдні',
  'east', 'west', 'north', 'south', 'center', 'центр'
]);

export function buildGeminiThreatPrompt(messageText: string, contextText?: string) {
  return [
    'Extract threats from Ukrainian military alert posts.',
    '',
    'CRITICAL: Distinguish between ORIGIN (where threat comes FROM) and TARGET (where threat is GOING TO).',
    '',
    'LINGUISTIC PATTERNS (Ukrainian):',
    '',
    'ORIGIN INDICATORS (source/launch point):',
    '- "з [місце]" = from [place] (e.g., "з Черкащини" = from Cherkasy region)',
    '- "від [місце]" = from [place]',
    '- "із [місце]" = from [place]',
    '- "з-під [місце]" = from under [place]',
    '- "з-за [місце]" = from behind [place]',
    '',
    'TARGET INDICATORS (destination):',
    '- "на [місце]" = to [place] (e.g., "на Кіровоградщину" = to Kirovohrad region)',
    '- "в [місце]" = to/in [place]',
    '- "у [місце]" = to/in [place]',
    '- "в напрямку [місце]" = towards [place]',
    '- "курсом на [місце]" = course towards [place]',
    '',
    'CURRENT LOCATION (where threat is NOW):',
    '- "БпЛА на [місто]" = UAV heading TO [city] (not currently there)',
    '- "БпЛА в районі [місто]" = UAV currently IN/AT area of [city]',
    '- "БпЛА над [місто]" = UAV currently OVER [city]',
    '- "БпЛА на [область]" = UAV heading TO [region]',
    '',
    'GEOGRAPHIC RULES:',
    '',
    'Black Sea (Чорне море):',
    '- Coordinates: WATER, latitude < 46°N, approximately 45.0°N, 31.0°E',
    '- If message says "з Чорного моря" → origin_lat/lng MUST be in WATER (~45.0°N, 31.0°E)',
    '- If message says "з акваторії Чорного моря" → origin_lat/lng MUST be in WATER',
    '',
    'Odesa (Одеса):',
    '- Coordinates: LAND, latitude ~46.5°N, longitude ~30.7°E',
    '- If message says "на Одесу" or "в напрямку Одеси" → target_lat/lng MUST be on LAND',
    '',
    'CRITICAL EXAMPLES (study these carefully):',
    '',
    'Example 1: "🛵 Нові групи ворожих БпЛА у напрямку Одеси з Чорного моря."',
    '- ORIGIN: "з Чорного моря" → Black Sea (WATER, ~45.0°N, 31.0°E)',
    '- TARGET: "у напрямку Одеси" → Odesa (LAND, ~46.5°N, 30.7°E)',
    '- Bearing: ~320° (from Black Sea to Odesa)',
    '',
    'Example 2: "🛵 Одещина - БпЛА на Одесу/Чорноморське з акваторїї Чорного моря."',
    '- ORIGIN: "з акваторії Чорного моря" → Black Sea aquatory (WATER, ~45.0°N, 31.0°E)',
    '- TARGET: "на Одесу/Чорноморське" → Odesa/Chornomorsk (LAND, ~46.5°N, 30.7°E for Odesa)',
    '',
    'Example 3: "🛵 БпЛА з Черкащини курсом на Кіровоградщину."',
    '- ORIGIN: "з Черкащини" → Cherkasy region (~49.5°N, 32.0°E)',
    '- TARGET: "курсом на Кіровоградщину" → Kirovohrad region (~48.5°N, 32.0°E)',
    '- Bearing: ~180° (south)',
    '',
    'Example 4: "🛵 БпЛА на Дніпро з південного заходу."',
    '- ORIGIN: "з південного заходу" → southwest (~48.0°N, 34.0°E)',
    '- TARGET: "на Дніпро" → Dnipro city (~48.5°N, 35.0°E)',
    '- Bearing: ~45° (northeast)',
    '',
    'Example 5: "🛵 Група БпЛА на півночі Київщини- курс на Житомирщину."',
    '- ORIGIN: "на півночі Київщини" → north of Kyiv region (~50.5°N, 30.5°E)',
    '- TARGET: "на Житомирщину" → Zhytomyr region (~50.3°N, 28.7°E)',
    '- Bearing: ~270° (west)',
    '',
    'Example 6: "🛵 БпЛА курсом на м.Харків з півночі."',
    '- ORIGIN: "з півночі" → north (~50.0°N, 36.0°E)',
    '- TARGET: "курсом на м.Харків" → Kharkiv city (~49.9°N, 36.2°E)',
    '- Bearing: ~180° (south)',
    '',
    'Example 7: "🛵 БпЛА з Херсонщини курсом на Миколаївщину"',
    '- ORIGIN: "з Херсонщини" → Kherson region (~46.6°N, 33.0°E)',
    '- TARGET: "курсом на Миколаївщину" → Mykolaiv region (~47.0°N, 32.0°E)',
    '- Bearing: ~315° (northwest)',
    '',
    'Example 8: "🛵 БпЛА в районі м. Запоріжжя"',
    '- CURRENT LOCATION: "в районі м. Запоріжжя" = in area of Zaporizhzhia city',
    '- No clear movement direction → origin and target may both be Zaporizhzhia',
    '',
    'Example 9: "🛵 Запоріжжя - БпЛА в напрямку міста з півдня."',
    '- ORIGIN: "з півдня" → south (~47.0°N, 35.0°E)',
    '- TARGET: "в напрямку міста" (referring to Zaporizhzhia) → Zaporizhzhia city (~47.8°N, 35.1°E)',
    '- Bearing: ~0° (north)',
    '',
    'Example 10: "🛵 БпЛА в акваторії Чорного моря курсом на Одесу."',
    '- ORIGIN: "в акваторії Чорного моря" → in Black Sea aquatory (WATER, ~45.0°N, 31.0°E)',
    '- TARGET: "курсом на Одесу" → Odesa (LAND, ~46.5°N, 30.7°E)',
    '- Bearing: ~320°',
    '',
    'COORDINATE REQUIREMENTS:',
    '- You MUST provide correct WGS84 coordinates directly in origin_lat/lng and target_lat/lng',
    '- DO NOT rely on server-side hints or fallbacks',
    '- If both origin and target are specified, they MUST be different coordinates (>1km apart)',
    '- If exact coordinates are unknown, provide approximate center coordinates of the region/city',
    '- Coordinates: latitude (-90 to 90), longitude (-180 to 180)',
    '- NEVER use 0.0, 0.0 as fallback - use null instead',
    '',
    'BEARING CALCULATION:',
    '- movement_bearing_deg = direction FROM origin TO target (0-360 degrees)',
    '- Formula: calculate bearing from (origin_lat, origin_lng) to (target_lat, target_lng)',
    '- Directions: North=0, North-East=45, East=90, South-East=135, South=180, South-West=225, West=270, North-West=315',
    '- Example: Black Sea (45.0°N, 31.0°E) → Odesa (46.5°N, 30.7°E) ≈ 320°',
    '',
    'OTHER RULES:',
    '- Combine context from multiple lines if they describe the same event',
    '- If one post describes several simultaneous threats, return one threat object per independently trackable threat',
    '- "Швидкісна ціль" (high-speed target) = missile threat',
    '- Action: "new" for new threats, "update" for updates, "clear" for cancellations/destroyed (Відбій, Збито, Чисто)',
    '- All hints (region_hint, origin_hint, target_hint, direction_text) must be in Ukrainian only',
    '',
    'Return strict JSON only with this schema:',
    '{"threats":[{"action":"new|update|clear","threat_kind":"uav|kab|missile|unknown","confidence":0.0,"region_hint":"string|null","origin_hint":"string|null","target_hint":"string|null","direction_text":"string|null","origin_lat":null,"origin_lng":null,"target_lat":null,"target_lng":null,"movement_bearing_deg":null}]}',
    'No markdown, no comments, no extra keys.',
    contextText ? `Recent context messages (for reference only, do not extract threats from these unless they are updated in the target message):\n${contextText}\n\nTarget message to parse:\n${messageText}` : `Text: ${messageText}`,
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

export function getThreatTtlMinutes(threatKind: 'uav' | 'kab' | 'missile' | 'unknown', hasTarget: boolean) {
  if (!hasTarget) {
    return 60;
  }
  const baseTtlMinutes =
    threatKind === 'uav' ? 60 : threatKind === 'kab' ? 60 : threatKind === 'missile' ? 35 : 45;

  return Math.min(baseTtlMinutes, 60);
}

export function isRetriableGeminiFailure(responseStatus: number | null, errorMessage: string | null | undefined) {
  if (responseStatus !== null) {
    return responseStatus === 408 || responseStatus === 409 || responseStatus === 425 || responseStatus === 429 || responseStatus >= 500;
  }

  const normalized = (errorMessage ?? '').toLowerCase();
  return [
    'timeout',
    'timed out',
    'aborted',
    'fetch failed',
    'network',
    'socket hang up',
    'econnreset',
    'econnrefused',
    'enotfound',
    'unexpected end of json input',
    'unexpected token',
    'unterminated string',
    'bad control character',
    'no text payload',
    'empty json payload',
  ].some((fragment) => normalized.includes(fragment));
}

export function shouldFallbackToGemini25Flash(responseStatus: number | null, errorMessage: string | null | undefined) {
  if (responseStatus === 503) {
    return true;
  }

  const normalized = (errorMessage ?? '').toLowerCase();
  return (
    normalized.includes('the operation was aborted due to timeout') ||
    normalized.includes('operation was aborted due to timeout') ||
    normalized.includes('timed out')
  );
}

export function getGeminiRetryDelayMs(retryAttempt: number, baseDelayMs: number, maxDelayMs = 10_000) {
  const normalizedAttempt = Math.max(1, Math.floor(retryAttempt));
  const normalizedBaseDelayMs = Math.max(1, Math.floor(baseDelayMs));
  return Math.min(normalizedBaseDelayMs * 2 ** (normalizedAttempt - 1), maxDelayMs);
}

@Injectable()
export class GeminiThreatParserService {
  private readonly logger = new Logger(GeminiThreatParserService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly databaseService: DatabaseService,
    private readonly subscriptionsService: SubscriptionsService,
  ) { }

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

        const contextRows = await this.databaseService.query<{ message_text: string; message_date: string }>(
          `
            SELECT message_text, message_date::text
            FROM telegram_messages_raw
            WHERE message_date <= $1
              AND raw_message_id != $2
            ORDER BY message_date DESC
            LIMIT 15
          `,
          [job.message_date, job.raw_message_id]
        );
        const contextText = contextRows.rows.length > 0
          ? contextRows.rows.reverse().map(r => `[${r.message_date}] ${r.message_text}`).join('\n')
          : undefined;

        const candidates = await this.parseWithGemini(job.job_id, attemptCount, job.message_text, contextText, job.raw_message_id);

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

  private async parseWithGemini(jobId: string, attemptCount: number, messageText: string, contextText?: string, rawMessageId?: string) {
    const llmTargets = this.buildLlmTargets();
    const maxRequestAttempts = this.getAliasedNumberEnv(['LLM_REQUEST_MAX_ATTEMPTS', 'GEMINI_REQUEST_MAX_ATTEMPTS'], 3);
    const retryBaseDelayMs = this.getAliasedNumberEnv(['LLM_REQUEST_RETRY_DELAY_MS', 'GEMINI_REQUEST_RETRY_DELAY_MS'], 1_500);
    const timeoutMs = this.getAliasedNumberEnv(['LLM_TIMEOUT_MS', 'GEMINI_TIMEOUT_MS'], 30_000);
    const prompt = buildGeminiThreatPrompt(messageText, contextText);
    let lastError: unknown = null;

    for (let targetIndex = 0; targetIndex < llmTargets.length; targetIndex += 1) {
      const baseTarget = llmTargets[targetIndex]!;
      let activeTarget = baseTarget;
      let requestAttemptLimit = maxRequestAttempts;
      const geminiFallbackModel =
        activeTarget.provider === 'gemini'
          ? this.configService.get<string>('GEMINI_FALLBACK_MODEL') ?? 'gemini-2.5-flash'
          : null;

      for (let requestAttempt = 1; requestAttempt <= requestAttemptLimit; requestAttempt += 1) {
        const requestPayloadJson = JSON.stringify(this.buildLlmRequestPayload(activeTarget, prompt));
        let responseStatus: number | null = null;
        let responseBody = '';
        let parsedCandidates: ParseCandidate[] = [];
        let parseErrorText: string | null = null;
        let shouldRetryCurrentTarget = false;
        let shouldSwitchGeminiModel = false;

        this.logger.log(
          `LLM request job=${jobId} job_attempt=${attemptCount} target=${targetIndex + 1}/${llmTargets.length} provider=${activeTarget.provider} request_attempt=${requestAttempt}/${requestAttemptLimit} model=${activeTarget.model} payload=${requestPayloadJson}`,
        );

        try {
          const response = await fetch(this.getLlmEndpoint(activeTarget), {
            method: 'POST',
            headers: this.getLlmHeaders(activeTarget),
            body: requestPayloadJson,
            signal: AbortSignal.timeout(timeoutMs),
          });

          responseStatus = response.status;
          responseBody = await response.text();
          this.logger.log(
            `LLM response job=${jobId} job_attempt=${attemptCount} target=${targetIndex + 1}/${llmTargets.length} provider=${activeTarget.provider} request_attempt=${requestAttempt}/${requestAttemptLimit} status=${response.status} model=${activeTarget.model} body=${responseBody}`,
          );

          if (!response.ok) {
            throw new Error(`${this.describeLlmTarget(activeTarget)} request failed: HTTP ${response.status} ${responseBody}`);
          }

          parsedCandidates = this.parseLlmCandidates(activeTarget, responseBody);

          this.logger.log(
            `LLM parsed candidates job=${jobId} job_attempt=${attemptCount} target=${targetIndex + 1}/${llmTargets.length} provider=${activeTarget.provider} request_attempt=${requestAttempt}/${requestAttemptLimit} model=${activeTarget.model} payload=${JSON.stringify(parsedCandidates)}`,
          );

          return parsedCandidates
            .map((item) => this.sanitizeCandidate(item))
            .filter((item): item is ParseCandidate => item !== null);
        } catch (error) {
          lastError = error;
          parseErrorText = this.stringifyError(error);
          shouldSwitchGeminiModel =
            activeTarget.provider === 'gemini' &&
            geminiFallbackModel !== null &&
            activeTarget.model !== geminiFallbackModel &&
            shouldFallbackToGemini25Flash(responseStatus, parseErrorText);
          shouldRetryCurrentTarget =
            (requestAttempt < requestAttemptLimit || shouldSwitchGeminiModel) &&
            isRetriableGeminiFailure(responseStatus, parseErrorText);
        } finally {
          await this.persistLlmExchange({
            jobId,
            attemptCount,
            model: activeTarget.model,
            requestPayloadJson,
            responseStatus,
            responseBody,
            parsedCandidates,
            errorText: parseErrorText
              ? `provider=${activeTarget.provider}; target=${targetIndex + 1}/${llmTargets.length}; request_attempt=${requestAttempt}/${requestAttemptLimit};${shouldSwitchGeminiModel ? ` fallback_model=${geminiFallbackModel};` : ''} ${parseErrorText}`
              : null,
            rawMessageId,
          });
        }

        if (!shouldRetryCurrentTarget) {
          break;
        }

        if (shouldSwitchGeminiModel && geminiFallbackModel !== null) {
          const previousTarget = activeTarget;
          if (requestAttempt === requestAttemptLimit) {
            requestAttemptLimit += 1;
          }
          activeTarget = {
            ...activeTarget,
            model: geminiFallbackModel,
          };
          this.logger.warn(
            `LLM model fallback scheduled job=${jobId} job_attempt=${attemptCount} target=${targetIndex + 1}/${llmTargets.length} from_provider=${previousTarget.provider} from_model=${previousTarget.model} to_provider=${activeTarget.provider} to_model=${activeTarget.model}`,
          );
        }

        const retryDelayMs = getGeminiRetryDelayMs(requestAttempt, retryBaseDelayMs);
        this.logger.warn(
          `LLM request retry scheduled job=${jobId} job_attempt=${attemptCount} target=${targetIndex + 1}/${llmTargets.length} provider=${activeTarget.provider} request_attempt=${requestAttempt}/${requestAttemptLimit} model=${activeTarget.model} delay_ms=${retryDelayMs}`,
        );
        await this.delay(retryDelayMs);
      }

      const fallbackTarget = llmTargets[targetIndex + 1];
      if (fallbackTarget) {
        this.logger.warn(
          `LLM provider fallback scheduled job=${jobId} job_attempt=${attemptCount} from_provider=${activeTarget.provider} from_model=${activeTarget.model} to_provider=${fallbackTarget.provider} to_model=${fallbackTarget.model}`,
        );
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error('All configured LLM providers failed to parse the Telegram threat message.');
  }

  private buildLlmTargets(): LlmTarget[] {
    const targets: LlmTarget[] = [];
    const grokApiKey = this.toNullableString(this.configService.get<string>('GROK_API_KEY'));
    const geminiApiKey = this.toNullableString(this.configService.get<string>('GEMINI_API_KEY'));

    if (grokApiKey) {
      targets.push({
        provider: 'grok',
        model: this.configService.get<string>('GROK_MODEL') ?? 'grok-4-1-fast-reasoning',
        apiKey: grokApiKey,
      });
    }

    if (geminiApiKey) {
      targets.push({
        provider: 'gemini',
        model: this.configService.get<string>('GEMINI_MODEL') ?? 'gemini-3-flash-preview',
        apiKey: geminiApiKey,
      });
    }

    if (targets.length === 0) {
      throw new Error('No LLM API key is configured. Set GROK_API_KEY or GEMINI_API_KEY.');
    }

    return targets;
  }

  private buildLlmRequestPayload(target: LlmTarget, prompt: string) {
    if (target.provider === 'grok') {
      return {
        model: target.model,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0.1,
        response_format: {
          type: 'json_object',
        },
      };
    }

    return {
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
  }

  private getLlmEndpoint(target: LlmTarget) {
    if (target.provider === 'grok') {
      return 'https://api.x.ai/v1/chat/completions';
    }

    return `https://generativelanguage.googleapis.com/v1beta/models/${target.model}:generateContent?key=${target.apiKey}`;
  }

  private getLlmHeaders(target: LlmTarget) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (target.provider === 'grok') {
      headers.Authorization = `Bearer ${target.apiKey}`;
    }

    return headers;
  }

  private parseLlmCandidates(target: LlmTarget, responseBody: string) {
    const textPayload = target.provider === 'grok'
      ? this.extractGrokTextPayload(responseBody)
      : this.extractGeminiTextPayload(responseBody);
    const jsonPayload = this.unwrapJson(textPayload);
    if (!jsonPayload) {
      throw new Error(`${this.describeLlmTarget(target)} returned empty JSON payload.`);
    }

    const decoded = JSON.parse(jsonPayload) as { threats?: ParseCandidate[] };
    return decoded.threats ?? [];
  }

  private extractGeminiTextPayload(responseBody: string) {
    const parsedBody = JSON.parse(responseBody) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{ text?: string }>;
        };
      }>;
    };

    const textPayload = parsedBody.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    if (!textPayload.trim()) {
      throw new Error('Gemini returned no text payload.');
    }

    return textPayload;
  }

  private extractGrokTextPayload(responseBody: string) {
    const parsedBody = JSON.parse(responseBody) as {
      choices?: Array<{
        message?: {
          content?: string | Array<{ text?: string }>;
        };
      }>;
    };

    const content = parsedBody.choices?.[0]?.message?.content;
    const textPayload = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('')
        : '';

    if (!textPayload.trim()) {
      throw new Error('Grok returned no text payload.');
    }

    return textPayload;
  }

  private describeLlmTarget(target: LlmTarget) {
    return target.provider === 'grok' ? 'Grok' : 'Gemini';
  }

  private getAliasedNumberEnv(names: string[], fallback: number) {
    for (const name of names) {
      const raw = this.configService.get<string>(name);
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }

    return fallback;
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
    rawMessageId?: string;
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
            raw_message_id,
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
            $10,
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
          params.rawMessageId ?? null,
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

    const action = candidate.action ?? 'new';
    const threatKind = this.normalizeThreatKind(candidate.threat_kind);
    const confidence = Math.max(0, Math.min(1, Number(candidate.confidence ?? 0)));

    const sanitized = {
      action,
      threat_kind: threatKind,
      confidence,
      region_hint: this.cleanDirectionalWords(this.toNullableString(candidate.region_hint)),
      origin_hint: this.cleanDirectionalWords(this.toNullableString(candidate.origin_hint)),
      target_hint: this.cleanDirectionalWords(this.toNullableString(candidate.target_hint)),
      direction_text: this.toNullableString(candidate.direction_text),
      origin_lat: this.toLatitude(candidate.origin_lat),
      origin_lng: this.toLongitude(candidate.origin_lng),
      target_lat: this.toLatitude(candidate.target_lat),
      target_lng: this.toLongitude(candidate.target_lng),
      movement_bearing_deg: this.toBearing(candidate.movement_bearing_deg),
    };

    // Validate coordinates and log warnings for suspicious patterns
    return this.validateAndCorrectCoordinates(sanitized);
  }

  private cleanDirectionalWords(hint: string | null): string | null {
    if (!hint) {
      return null;
    }

    const cleaned = hint
      // Remove directional phrases first
      .replace(/(?:^|\s)(на\s+півночі|на\s+півдні|на\s+заході|на\s+сході)(?:\s|$)/gi, ' ')
      // Then remove individual directional words
      .replace(/(?:^|\s)(північний|південний|західний|східний|схід|захід|південь|північ|центр|east|west|north|south|center)(?:\s|$)/gi, ' ')
      // Remove motion verbs
      .replace(/(?:^|\s)(напрямок|курс)(?:\s|$)/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    return cleaned || null;
  }

  private async persistCandidates(
    client: PoolClient,
    job: PendingJobRow,
    candidates: ParseCandidate[],
  ) {
    let overlaysCreated = 0;

    for (const candidate of candidates) {
      const fallbackHint = candidate.region_hint;

      // Hybrid approach: Priority to LLM coordinates, fallback to region_catalog
      let originLat = candidate.origin_lat;
      let originLng = candidate.origin_lng;

      // Fallback: if LLM coordinates are missing or invalid, use region_catalog
      if (!this.areValidCoordinates(originLat, originLng)) {
        const resolvedOrigin = await this.resolveRegionHintFromCatalog(client, candidate.origin_hint ?? fallbackHint);
        if (resolvedOrigin) {
          originLat = resolvedOrigin.latitude;
          originLng = resolvedOrigin.longitude;
          this.logger.debug(`Used region_catalog fallback for origin: ${candidate.origin_hint} -> ${originLat}, ${originLng}`);
        } else {
          // Final fallback to old resolveRegionHint method
          const origin = await this.resolveRegionHint(client, candidate.origin_hint ?? fallbackHint);
          if (origin) {
            originLat = origin.latitude;
            originLng = origin.longitude;
          }
        }
      }

      // Same logic for target
      let targetLat = candidate.target_lat;
      let targetLng = candidate.target_lng;

      if (!this.areValidCoordinates(targetLat, targetLng)) {
        const resolvedTarget = await this.resolveRegionHintFromCatalog(client, candidate.target_hint ?? fallbackHint);
        if (resolvedTarget) {
          targetLat = resolvedTarget.latitude;
          targetLng = resolvedTarget.longitude;
          this.logger.debug(`Used region_catalog fallback for target: ${candidate.target_hint} -> ${targetLat}, ${targetLng}`);
        } else {
          // Final fallback to old resolveRegionHint method
          const target = await this.resolveRegionHint(client, candidate.target_hint ?? fallbackHint);
          if (target) {
            targetLat = target.latitude;
            targetLng = target.longitude;
          }
        }
      }

      // Get UIDs for database consistency (still needed for deduplication)
      const origin = await this.resolveRegionHint(client, candidate.origin_hint ?? fallbackHint);
      const target = await this.resolveRegionHint(client, candidate.target_hint ?? fallbackHint);

      const bearing =
        candidate.movement_bearing_deg ??
        (originLat !== null && originLng !== null && targetLat !== null && targetLng !== null
          ? this.calculateBearing(originLat, originLng, targetLat, targetLng)
          : null);

      // Validate bearing matches direction hints
      if (bearing !== null && candidate.direction_text) {
        this.validateBearingAgainstDirection(bearing, candidate.direction_text);
      }

      const occurredAt = new Date(job.message_date);
      // Determine if threat has a target based on either region catalog OR coordinates
      // This ensures threats from Black Sea (no region) but with coordinates get proper TTL
      const hasTargetCoordinates = this.areValidCoordinates(targetLat, targetLng);
      const hasTargetRegion = target !== null;
      const expiresAt = this.estimateExpiry(occurredAt, candidate.threat_kind, hasTargetRegion || hasTargetCoordinates);
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

      if (candidate.action === 'update' || candidate.action === 'clear') {
        const updateResult = await client.query(
          `
            UPDATE threat_vectors
            SET expires_at = NOW()
            WHERE threat_kind = $1
              AND expires_at > NOW()
              AND (
                ($2::int IS NOT NULL AND target_uid = $2)
                OR ($3::int IS NOT NULL AND origin_uid = $3)
              )
            RETURNING vector_id
          `,
          [candidate.threat_kind, target?.uid ?? null, origin?.uid ?? null]
        );

        if (updateResult.rows.length > 0) {
          const updatedVectorIds = updateResult.rows.map(r => r.vector_id);
          await client.query(
            `
              UPDATE threat_visual_overlays
              SET status = 'inactive',
                  updated_at = NOW()
              WHERE vector_id = ANY($1::uuid[])
            `,
            [updatedVectorIds]
          );
        }
      }

      if (candidate.action === 'clear') {
        continue;
      }

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
          -- MODIFIED: Improved prioritization
          CASE
            WHEN rc.title_uk = ANY($1::text[]) THEN 0  -- Exact match first
            WHEN EXISTS (
              SELECT 1 FROM unnest($1::text[]) AS hint_variant
              WHERE rc.title_uk ILIKE (hint_variant || '%')
            ) THEN 1  -- Starts with hint
            ELSE 2  -- Contains hint
          END,
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

      const lowerCleaned = cleaned.toLowerCase();

      // MODIFIED: Enhanced directional word filtering
      // Check if cleaned contains any directional words as substrings
      const containsDirectionalWord = Array.from(DIRECTIONAL_STOP_WORDS).some(stopWord =>
        lowerCleaned.includes(stopWord)
      );

      if (cleaned.length >= 3 &&
          !REGION_HINT_STOP_WORDS.has(lowerCleaned) &&
          !DIRECTIONAL_STOP_WORDS.has(lowerCleaned) &&
          !containsDirectionalWord) {
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
      // MODIFIED: Add English directional words and center
      .replace(/\b(напрямок|курс|на\s+півночі|на\s+півдні|на\s+заході|на\s+сході|північний|південний|західний|східний|схід|захід|південь|північ|центр|east|west|north|south|center)\b/gi, ' ')
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

    // MODIFIED: Improved word extraction with multi-word phrases
    const words = normalized
      .split(' ')
      .filter((word) => {
        const lowerWord = word.toLowerCase();
        return word.length >= 4 &&
               !REGION_HINT_STOP_WORDS.has(lowerWord) &&
               !DIRECTIONAL_STOP_WORDS.has(lowerWord);
      });

    // Add meaningful 2-word combinations for better geographic context
    if (words.length >= 2) {
      for (let i = 0; i < words.length - 1; i++) {
        push(`${words[i]} ${words[i + 1]}`);
      }
    }

    // Add meaningful 3-word combinations for complex geographic names
    if (words.length >= 3) {
      for (let i = 0; i < words.length - 2; i++) {
        push(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
      }
    }

    // Finally add individual words
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

  private estimateExpiry(occurredAt: Date, threatKind: ParseCandidate['threat_kind'], hasTarget: boolean) {
    const ttlMinutes = getThreatTtlMinutes(threatKind, hasTarget);
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
    const bearing = (theta + 360) % 360;

    // Debug logging for bearing calculations
    this.logger.debug(
      `Calculated bearing: ${bearing.toFixed(1)}° from origin (${lat1.toFixed(4)}, ${lon1.toFixed(4)}) to target (${lat2.toFixed(4)}, ${lon2.toFixed(4)})`
    );

    return bearing;
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
    if (value === null || value === undefined || value === '') {
      return null;
    }
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

  private async delay(ms: number) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private getNumberEnv(name: string, fallback: number) {
    const raw = this.configService.get<string>(name);
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return fallback;
    }

    return parsed;
  }

  private areValidCoordinates(lat: number | null, lng: number | null): boolean {
    if (lat === null || lng === null) {
      return false;
    }

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return false;
    }

    if (lat === 0 && lng === 0) {
      return false;
    }

    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return false;
    }

    // Check if coordinates are reasonably close to Ukraine (45-52°N, 22-40°E)
    // Allow some margin for Black Sea and neighboring regions
    if (lat < 43 || lat > 55 || lng < 20 || lng > 42) {
      return false;
    }

    return true;
  }

  private async resolveRegionHintFromCatalog(client: PoolClient, hint: string | null): Promise<RegionPoint | null> {
    const value = this.toNullableString(hint);
    if (!value) {
      return null;
    }

    // Normalize the hint: lowercase, remove common suffixes
    const normalizedHint = value
      .toLowerCase()
      .replace(/щина$/gi, 'щина') // Normalize oblast names
      .replace(/щина$/gi, 'щин')  // Alternative normalization
      .replace(/щина$/gi, 'щину')
      .replace(/щина$/gi, 'щині')
      .replace(/щина$/gi, 'щиною')
      .replace(/область$/gi, '')
      .replace(/район$/gi, '')
      .replace(/обл\.$/gi, '')
      .replace(/р-н$/gi, '')
      .trim();

    if (normalizedHint.length < 3) {
      return null;
    }

    // Get all active oblasts from region_catalog
    const oblastsResult = await client.query<{ uid: number; title_uk: string; latitude: number; longitude: number }>(
      `
        SELECT rc.uid,
               rc.title_uk,
               ST_Y(ST_Centroid(rg.geom)) AS latitude,
               ST_X(ST_Centroid(rg.geom)) AS longitude
        FROM region_catalog rc
        JOIN region_geometry rg ON rg.uid = rc.uid
        WHERE rc.region_type = 'oblast'
          AND rc.is_active = TRUE
        ORDER BY CHAR_LENGTH(rc.title_uk) DESC
      `
    );

    // Try to find matching oblast
    for (const oblast of oblastsResult.rows) {
      const normalizedOblast = oblast.title_uk
        .toLowerCase()
        .replace(/ська$/gi, 'ськ')
        .replace(/ська$/gi, 'ська')
        .replace(/ська$/gi, 'ській')
        .replace(/ська$/gi, 'ську')
        .replace(/ська$/gi, 'ською')
        .replace(/область$/gi, '')
        .trim();

      // Check if normalized hint contains normalized oblast name (or vice versa)
      if (normalizedHint.includes(normalizedOblast) || normalizedOblast.includes(normalizedHint)) {
        return {
          uid: oblast.uid,
          title_uk: oblast.title_uk,
          latitude: oblast.latitude,
          longitude: oblast.longitude,
        };
      }
    }

    return null;
  }

  private calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const toRad = (value: number) => (value * Math.PI) / 180;
    const R = 6371; // Earth's radius in km

    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  private validateAndCorrectCoordinates(candidate: ParseCandidate): ParseCandidate {
    const result = { ...candidate };

    // Check if origin and target are too close (< 1km)
    if (this.areValidCoordinates(result.origin_lat, result.origin_lng) &&
        this.areValidCoordinates(result.target_lat, result.target_lng)) {
      const distance = this.calculateDistance(
        result.origin_lat!,
        result.origin_lng!,
        result.target_lat!,
        result.target_lng!
      );

      if (distance < 1) {
        this.logger.warn(
          `Origin and target coordinates too close (${distance.toFixed(2)}km). ` +
          `Origin: ${result.origin_lat}, ${result.origin_lng}, ` +
          `Target: ${result.target_lat}, ${result.target_lng}, ` +
          `Origin hint: ${result.origin_hint}, Target hint: ${result.target_hint}`
        );
      }
    }

    // Check if origin claims to be from Black Sea but has land coordinates
    if (result.origin_hint && result.origin_hint.toLowerCase().includes('чорного моря')) {
      if (this.areValidCoordinates(result.origin_lat, result.origin_lng) && result.origin_lat! > 46) {
        this.logger.warn(
          `Origin hint mentions Black Sea but coordinates are on land (lat=${result.origin_lat}). ` +
          `Expected latitude < 46°N for water. Origin hint: ${result.origin_hint}`
        );
      }
    }

    // Check if target claims to be Odesa but coordinates don't match
    if (result.target_hint && (result.target_hint.toLowerCase().includes('одес') || result.target_hint.toLowerCase().includes('чорномор'))) {
      if (this.areValidCoordinates(result.target_lat, result.target_lng)) {
        const distanceToOdesa = this.calculateDistance(
          result.target_lat!,
          result.target_lng!,
          46.5, // Odesa approximate latitude
          30.7  // Odesa approximate longitude
        );

        if (distanceToOdesa > 50) {
          this.logger.warn(
            `Target hint mentions Odesa/Chornomorsk but coordinates are far from Odesa (${distanceToOdesa.toFixed(2)}km). ` +
            `Target: ${result.target_lat}, ${result.target_lng}, Target hint: ${result.target_hint}`
          );
        }
      }
    }

    return result;
  }

  private validateBearingAgainstDirection(bearing: number, directionText: string): void {
    const normalizedDirection = directionText.toLowerCase();
    let expectedRange: [number, number] | null = null;

    // Define expected bearing ranges for different directions (with ±45° tolerance)
    if (normalizedDirection.includes('північ') && !normalizedDirection.includes('півден')) {
      // North (0° ± 45° = 315-360° and 0-45°)
      expectedRange = [315, 45]; // Special case: wraps around 0
    } else if (normalizedDirection.includes('півден')) {
      // South (180° ± 45° = 135-225°)
      expectedRange = [135, 225];
    } else if (normalizedDirection.includes('схід') && !normalizedDirection.includes('захід')) {
      // East (90° ± 45° = 45-135°)
      expectedRange = [45, 135];
    } else if (normalizedDirection.includes('захід')) {
      // West (270° ± 45° = 225-315°)
      expectedRange = [225, 315];
    } else if (normalizedDirection.includes('північно-схід') || normalizedDirection.includes('пн-сх')) {
      // North-East (45° ± 22.5° = 22.5-67.5°)
      expectedRange = [22.5, 67.5];
    } else if (normalizedDirection.includes('південно-схід') || normalizedDirection.includes('пд-сх')) {
      // South-East (135° ± 22.5° = 112.5-157.5°)
      expectedRange = [112.5, 157.5];
    } else if (normalizedDirection.includes('південно-захід') || normalizedDirection.includes('пд-зх')) {
      // South-West (225° ± 22.5° = 202.5-247.5°)
      expectedRange = [202.5, 247.5];
    } else if (normalizedDirection.includes('північно-захід') || normalizedDirection.includes('пн-зх')) {
      // North-West (315° ± 22.5° = 292.5-337.5°)
      expectedRange = [292.5, 337.5];
    }

    if (expectedRange) {
      const [min, max] = expectedRange;
      let inRange = false;

      if (min > max) {
        // Range wraps around 0° (e.g., North: 315-360° and 0-45°)
        inRange = bearing >= min || bearing <= max;
      } else {
        // Normal range
        inRange = bearing >= min && bearing <= max;
      }

      if (!inRange) {
        this.logger.warn(
          `Bearing ${bearing.toFixed(1)}° does not match direction "${directionText}" ` +
          `(expected range: ${min.toFixed(1)}°-${max.toFixed(1)}°)`
        );
      }
    }
  }
}
