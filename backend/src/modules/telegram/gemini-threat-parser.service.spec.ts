import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildGeminiThreatPrompt,
  buildThreatVectorDedupeKey,
  GeminiThreatParserService,
  getGeminiRetryDelayMs,
  getThreatTtlMinutes,
  isRetriableGeminiFailure,
  shouldFallbackToGemini25Flash,
} from './gemini-threat-parser.service';

test('buildGeminiThreatPrompt asks the LLM to split shared-course multi-region UAV posts', () => {
  const prompt = buildGeminiThreatPrompt('🛵 БпЛА на Сумщині і Харківщині курсом на Полтавщину.');

  assert.match(prompt, /return one threat object per independently trackable threat/i);
  assert.match(prompt, /Сумщині і Харківщині курсом на Полтавщину/u);
  assert.match(prompt, /do not merge different current locations into one threat object/i);
});

test('buildGeminiThreatPrompt asks the LLM to keep one current location when splitting one-origin multi-target UAV posts', () => {
  const prompt = buildGeminiThreatPrompt('🛵 Група БпЛА на Сумщині курсом на Полтавщину та Харківщину.');

  assert.match(prompt, /region_hint must describe the threat's current location now/i);
  assert.match(prompt, /Сумщині курсом на Полтавщину та Харківщину/u);
  assert.match(prompt, /split it into separate threat objects by target while keeping the same current location in region_hint/i);
});

test('buildGeminiThreatPrompt requires hints and directions to be returned in Ukrainian', () => {
  const prompt = buildGeminiThreatPrompt('🚀Пуски керованих авіаційних бомб на Donetsk region.');

  assert.match(prompt, /region_hint, origin_hint, target_hint, and direction_text must be written in Ukrainian only/i);
  assert.match(prompt, /Never return English place or direction names/i);
});

test('buildGeminiThreatPrompt uses null placeholders for unknown numeric fields', () => {
  const prompt = buildGeminiThreatPrompt('🛵 БпЛА на півночі Чернігівщини.');

  assert.match(prompt, /"origin_lat":null/);
  assert.match(prompt, /"movement_bearing_deg":null/);
  assert.match(prompt, /DO NOT use 0 as fallback/i);
});

test('buildThreatVectorDedupeKey keeps two origins from one post distinct when only region_hint differs', () => {
  const common = {
    rawMessageId: '42',
    threatKind: 'uav' as const,
    originHint: null,
    targetHint: 'Полтавщина',
    directionText: 'курсом на Полтавщину',
    originUid: null,
    targetUid: 531,
    targetLat: 49.5883,
    targetLng: 34.5514,
  };

  const sumyKey = buildThreatVectorDedupeKey({
    ...common,
    regionHint: 'Сумщина',
    originLat: 50.9077,
    originLng: 34.7981,
  });
  const kharkivKey = buildThreatVectorDedupeKey({
    ...common,
    regionHint: 'Харківщина',
    originLat: 49.9935,
    originLng: 36.2304,
  });

  assert.notStrictEqual(sumyKey, kharkivKey);
});

test('buildThreatVectorDedupeKey still deduplicates identical parsed threats from the same post', () => {
  const params = {
    rawMessageId: '42',
    threatKind: 'uav' as const,
    regionHint: 'Сумщина',
    originHint: null,
    targetHint: 'Полтавщина',
    directionText: 'курсом на Полтавщину',
    originUid: null,
    targetUid: 531,
    originLat: 50.9077,
    originLng: 34.7981,
    targetLat: 49.5883,
    targetLng: 34.5514,
  };

  assert.strictEqual(buildThreatVectorDedupeKey(params), buildThreatVectorDedupeKey(params));
});

test('getThreatTtlMinutes caps telegram threats at two hours', () => {
  assert.equal(getThreatTtlMinutes('uav'), 120);
  assert.equal(getThreatTtlMinutes('kab'), 40);
  assert.equal(getThreatTtlMinutes('missile'), 35);
  assert.equal(getThreatTtlMinutes('unknown'), 45);
});

test('buildRegionHintVariants does not emit generic administrative words for English region hints', () => {
  const service = new GeminiThreatParserService(
    {
      get() {
        return '';
      },
    } as never,
    {
      query: async () => ({ rows: [] }),
    } as never,
    {} as never,
  );

  const variants = (service as unknown as { buildRegionHintVariants: (value: string) => string[] }).buildRegionHintVariants(
    'Donetsk region',
  );

  assert.equal(variants.includes('область'), false);
  assert.equal(variants.includes('Донецьк'), true);
});

test('isRetriableGeminiFailure retries transient HTTP responses and network-like failures', () => {
  assert.equal(isRetriableGeminiFailure(429, 'Gemini request failed: HTTP 429'), true);
  assert.equal(isRetriableGeminiFailure(503, 'Gemini request failed: HTTP 503'), true);
  assert.equal(isRetriableGeminiFailure(400, 'Gemini request failed: HTTP 400'), false);
  assert.equal(isRetriableGeminiFailure(null, 'fetch failed'), true);
  assert.equal(isRetriableGeminiFailure(null, 'Gemini returned no text payload.'), true);
  assert.equal(isRetriableGeminiFailure(null, 'No LLM API key is configured.'), false);
});

test('shouldFallbackToGemini25Flash only switches models for timeout and 503 overload failures', () => {
  assert.equal(
    shouldFallbackToGemini25Flash(
      503,
      'Gemini request failed: HTTP 503 {"error":{"message":"This model is currently experiencing high demand.","status":"UNAVAILABLE"}}',
    ),
    true,
  );
  assert.equal(shouldFallbackToGemini25Flash(null, 'The operation was aborted due to timeout'), true);
  assert.equal(shouldFallbackToGemini25Flash(null, 'Request timed out after 30000ms'), true);
  assert.equal(shouldFallbackToGemini25Flash(429, 'Gemini request failed: HTTP 429'), false);
  assert.equal(shouldFallbackToGemini25Flash(null, 'Gemini returned no text payload.'), false);
});

test('parseWithGemini falls back from grok to gemini-3 and then gemini-2.5 in order', async () => {
  const configValues: Record<string, string> = {
    GROK_API_KEY: 'test-grok-api-key',
    GROK_MODEL: 'grok-4-1-fast-reasoning',
    GEMINI_API_KEY: 'test-api-key',
    GEMINI_MODEL: 'gemini-3-flash-preview',
    GEMINI_FALLBACK_MODEL: 'gemini-2.5-flash',
    GEMINI_REQUEST_MAX_ATTEMPTS: '1',
    GEMINI_REQUEST_RETRY_DELAY_MS: '1',
    GEMINI_TIMEOUT_MS: '30000',
  };
  const requestedEndpoints: string[] = [];
  const requestBodies: string[] = [];
  const originalFetch = global.fetch;
  const service = new GeminiThreatParserService(
    {
      get(name: string) {
        return configValues[name];
      },
    } as never,
    {
      query: async () => ({ rows: [] }),
    } as never,
    {} as never,
  );

  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requestedEndpoints.push(url);
    requestBodies.push(typeof init?.body === 'string' ? init.body : '');

    if (requestedEndpoints.length <= 2) {
      return new Response(
        JSON.stringify({
          error: {
            code: 503,
            message: 'This model is currently experiencing high demand. Please try again later.',
            status: 'UNAVAILABLE',
          },
        }),
        {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [{ text: '{"threats":[]}' }],
            },
          },
        ],
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }) as typeof fetch;

  try {
    (service as unknown as { delay: (ms: number) => Promise<void> }).delay = async () => undefined;

    const parsed = await (
      service as unknown as {
        parseWithGemini: (jobId: string, attemptCount: number, messageText: string) => Promise<unknown[]>;
      }
    ).parseWithGemini('job-1', 1, 'Тестове повідомлення');

    assert.deepEqual(parsed, []);
    assert.equal(requestedEndpoints.length, 3);
    assert.equal(requestedEndpoints[0], 'https://api.x.ai/v1/chat/completions');
    assert.match(requestBodies[0], /"model":"grok-4-1-fast-reasoning"/);
    assert.match(requestedEndpoints[1], /models\/gemini-3-flash-preview:generateContent/);
    assert.match(requestedEndpoints[2], /models\/gemini-2\.5-flash:generateContent/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('persistCandidates replaces default zero bearing with a derived course when coordinates disagree', async () => {
  const capturedBearingParams: unknown[] = [];
  const fakeClient = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('INSERT INTO threat_vectors')) {
        capturedBearingParams.push(params[15]);
        return { rowCount: 1, rows: [{ inserted: 1 }] };
      }

      return { rowCount: 0, rows: [] };
    },
  };

  const service = new GeminiThreatParserService(
    {
      get() {
        return '';
      },
    } as never,
    {
      query: async () => ({ rows: [] }),
    } as never,
    {} as never,
  );

  (service as unknown as { resolveRegionHint: (client: unknown, hint: string | null) => Promise<null> }).resolveRegionHint =
    async () => null;
  (
    service as unknown as {
      applyThreatVectorToRuntime: (
        client: unknown,
        uid: number | null,
        candidate: unknown,
        occurredAt: Date,
      ) => Promise<null>;
    }
  ).applyThreatVectorToRuntime = async () => null;

  await (
    service as unknown as {
      persistCandidates: (client: typeof fakeClient, job: unknown, candidates: unknown[]) => Promise<unknown>;
    }
  ).persistCandidates(
    fakeClient,
    {
      job_id: 'job-1',
      raw_message_id: 'raw-1',
      message_text: 'Тестове повідомлення',
      message_date: '2026-04-20T10:00:00.000Z',
    },
    [
      {
        threat_kind: 'uav',
        confidence: 0.9,
        region_hint: 'Чернігівщина',
        origin_hint: null,
        target_hint: 'Київщина',
        direction_text: 'південний',
        origin_lat: 50,
        origin_lng: 30,
        target_lat: 49,
        target_lng: 30,
        movement_bearing_deg: 0,
      },
    ],
  );

  assert.equal(capturedBearingParams.length, 1);
  assert.equal(capturedBearingParams[0], 180);
});

test('getGeminiRetryDelayMs uses exponential backoff and caps the delay', () => {
  assert.equal(getGeminiRetryDelayMs(1, 1500), 1500);
  assert.equal(getGeminiRetryDelayMs(2, 1500), 3000);
  assert.equal(getGeminiRetryDelayMs(3, 1500), 6000);
  assert.equal(getGeminiRetryDelayMs(4, 1500), 10000);
});