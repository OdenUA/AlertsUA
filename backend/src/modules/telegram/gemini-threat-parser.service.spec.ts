import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildGeminiThreatPrompt,
  buildThreatVectorDedupeKey,
  getThreatTtlMinutes,
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