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
  assert.equal(getThreatTtlMinutes('uav', true), 120);
  assert.equal(getThreatTtlMinutes('kab', true), 60);
  assert.equal(getThreatTtlMinutes('missile', true), 35);
  assert.equal(getThreatTtlMinutes('unknown', true), 45);
  assert.equal(getThreatTtlMinutes('missile', false), 60);
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
  assert.equal(isRetriableGeminiFailure(null, 'GEMINI_API_KEY is not configured.'), false);
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

test('parseWithGemini retries the same request on gemini-2.5-flash after a 503 overload on the primary model', async () => {
  const configValues: Record<string, string> = {
    GEMINI_API_KEY: 'test-api-key',
    GEMINI_MODEL: 'gemini-3-flash-preview',
    GEMINI_FALLBACK_MODEL: 'gemini-2.5-flash',
    GEMINI_REQUEST_MAX_ATTEMPTS: '1',
    GEMINI_REQUEST_RETRY_DELAY_MS: '1',
    GEMINI_TIMEOUT_MS: '30000',
  };
  const requestedEndpoints: string[] = [];
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

  global.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    requestedEndpoints.push(url);

    if (requestedEndpoints.length === 1) {
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
    assert.equal(requestedEndpoints.length, 2);
    assert.match(requestedEndpoints[0], /models\/gemini-3-flash-preview:generateContent/);
    assert.match(requestedEndpoints[1], /models\/gemini-2\.5-flash:generateContent/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('parseWithGemini tries Grok first and falls back to Gemini when Grok fails', async () => {
  const configValues: Record<string, string> = {
    GROK_API_KEY: 'grok-api-key',
    GROK_MODEL: 'grok-4-1-fast-reasoning',
    GEMINI_API_KEY: 'gemini-api-key',
    GEMINI_MODEL: 'gemini-3-flash-preview',
    GEMINI_REQUEST_MAX_ATTEMPTS: '1',
    GEMINI_REQUEST_RETRY_DELAY_MS: '1',
    GEMINI_TIMEOUT_MS: '30000',
  };
  const requests: Array<{ url: string; authorization: string | null; body: string }> = [];
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
    const headers = (init?.headers ?? {}) as Record<string, string>;
    requests.push({
      url: String(input),
      authorization: headers.Authorization ?? null,
      body: String(init?.body ?? ''),
    });

    if (requests.length === 1) {
      return new Response(
        JSON.stringify({
          error: {
            code: 503,
            message: 'Grok temporary failure',
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
    const parsed = await (
      service as unknown as {
        parseWithGemini: (jobId: string, attemptCount: number, messageText: string) => Promise<unknown[]>;
      }
    ).parseWithGemini('job-2', 1, 'Тестове повідомлення');

    assert.deepEqual(parsed, []);
    assert.equal(requests.length, 2);
    assert.match(requests[0]!.url, /api\.x\.ai\/v1\/chat\/completions/);
    assert.equal(requests[0]!.authorization, 'Bearer grok-api-key');
    assert.match(requests[0]!.body, /"model":"grok-4-1-fast-reasoning"/);
    assert.match(requests[1]!.url, /models\/gemini-3-flash-preview:generateContent/);
    assert.equal(requests[1]!.authorization, null);
  } finally {
    global.fetch = originalFetch;
  }
});

test('getGeminiRetryDelayMs uses exponential backoff and caps the delay', () => {
  assert.equal(getGeminiRetryDelayMs(1, 1500), 1500);
  assert.equal(getGeminiRetryDelayMs(2, 1500), 3000);
  assert.equal(getGeminiRetryDelayMs(3, 1500), 6000);
  assert.equal(getGeminiRetryDelayMs(4, 1500), 10000);
});