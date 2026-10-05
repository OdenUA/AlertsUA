import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../common/database/database.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { AlertsService } from '../alerts/alerts.service';
import { CacheService } from '../../common/cache/cache.service';
import { CACHE_KEYS, CACHE_CHANNELS } from '../../common/cache/cache.constants';
import { isReconOnlyReport } from './recon-report.util';

type AlertStatus = 'A' | 'P' | 'N' | ' ';
type AlertType = 'air_raid' | 'artillery_shelling' | 'urban_fights' | 'chemical' | 'nuclear';

type ParseCandidate = {
  action: 'new' | 'update' | 'clear';
  threat_kind: 'uav' | 'kab' | 'missile' | 'ballistic' | 'tactical_aviation' | 'unknown';
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
  source_excerpt: string | null;
  origin_inferred?: boolean;
  origin_reanchored?: boolean;
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
  provider: 'deepseek' | 'grok' | 'gemini';
  model: string;
  apiKey: string;
};

const REGION_HINT_STOP_WORDS = new Set(['область', 'район', 'region', 'oblast', 'raion', 'district']);

// Section headers of multi-threat messages (e.g. "Ситуація по реактивних БпЛА:")
// normalized to short nominative titles for client popups. Unknown wording falls
// back to the verbatim header line.
const THREAT_HEADER_TITLE_MAP: Array<[RegExp, string]> = [
  [/^реактивн(ий|і|их|им)?\s+бпла$/iu, 'Реактивний БпЛА:'],
  [/^бпла(?:[ «"-]*шахед(и|ів)?)?$/iu, 'БпЛА:'],
  [/^шахед(и|ів)$/iu, 'БпЛА:'],
  [/^каб(и|ів|ах)?$/iu, 'КАБ:'],
  [/^ракет(и|ах)?$/iu, 'Ракети:'],
  [/^швидкісн(а\s+ціль|і\s+цілі|их\s+цілей)$/iu, 'Швидкісна ціль:'],
];

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

type HostileGeometries = {
  ukraineGeoJson: string;
  occupiedGeoJsons: string[];
  loadedAt: number;
};

// Coarse Black Sea + Sea of Azov polygons. Used only to classify a ray exit as
// "hostile sea" (threats can come over the water) vs a non-hostile western
// neighbour (Poland/Slovakia/Hungary/Romania/Moldova).
const HOSTILE_SEA_WKT =
  'MULTIPOLYGON(((27.8 45.2, 27.8 47.0, 41.5 47.0, 41.5 42.8, 28.5 42.8, 27.8 45.2)), ((34.3 45.0, 34.3 47.7, 40.0 47.7, 40.0 45.0, 34.3 45.0)))';

// Same multi-path lookup as OccupiedTerritoriesService (the parse worker runs
// from the release directory, so cwd-relative paths vary).
function resolveOccupiedTerritoriesDataPath(): string | null {
  const candidates = [
    path.join(process.cwd(), 'data', 'occupied-territories.geojson'),
    path.join(process.cwd(), '..', 'data', 'occupied-territories.geojson'),
    path.join(process.cwd(), '..', '..', 'data', 'occupied-territories.geojson'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function buildGeminiThreatPrompt(messageText: string) {
  const promptText = `Extract threats from Ukrainian military alert posts.

CRITICAL: Distinguish between ORIGIN (where threat comes FROM) and TARGET (where threat is GOING TO).

LINGUISTIC PATTERNS (Ukrainian):
- ORIGIN (comes from): "з X" / "із X" / "від X" / "з-під X" / "з-за X" ("з Черкащини" = from Cherkasy region)
- TARGET (goes to): "на X" / "в X" / "у X" / "в напрямку X" / "в сторону X" / "курсом на X" ("на Кіровоградщину" = to Kirovohrad region)
- CURRENT LOCATION (threat is there NOW → use as origin): "над X", "в районі X", "біля X", "по межі X і Y" / "на межі X та Y" (= ON the border between X and Y), "БпЛА на X" (context-dependent: AT or HEADING TO)
- "вектор - [city1]/[city2]" = exact movement direction towards those towns (use their coordinates as target)
- COMPASS COURSE ("курс південний" / "рух на схід") = the threat heads along the NAMED COMPASS DIRECTION — see rule 0 of LOCATION RESOLUTION PRIORITY
- When patterns conflict, LOCATION RESOLUTION PRIORITY below is the single authority.

SECTION HEADERS (REGION PREFIXES) — CRITICAL:
- A line starting with "Харківщина:", "Дніпропетровщина:", "Запорізька область:" etc. is a SECTION HEADER naming the oblast that the lines below it belong to. Colloquial "-щина"/"-цина" names map to official oblast names (Харківщина = Харківська область, Полтавщина = Полтавська область, Запоріжжя = Запорізька область).
- The threat's location MUST be consistent with its section header; set region_hint to the official oblast name from the header.
- DISAMBIGUATE ambiguous toponyms using the section header FIRST. Similar-sounding towns in different oblasts are DIFFERENT places (Васильківка in Dnipropetrovsk oblast is NOT Василівка in Zaporizhzhia oblast). If no town with that name exists in the header oblast, do NOT relocate the threat — use the header oblast for the coordinates and put the literal place name in target_hint.
- A course INTO a different oblast is allowed only when the text explicitly names it as the destination ("курсом на Полтавщину") — then target coordinates lie in the DESTINATION oblast, region_hint stays the header oblast.

Example 1: "🛵 БпЛА ➡️ курсом на Синельникове на Дніпропетровщині"
- ORIGIN: "окупований південний схід" (implied/inferred occupied Zaporizhzhia/Donetsk frontline, ~47.6°N, 36.7°E), origin_inferred: true
- TARGET: "курсом на Синельникове" → Synelnykove (~48.32°N, 35.53°E)
- Bearing: ~330° (north-west)
- CRITICAL: origin not specified → do NOT use Dnipropetrovsk center; infer from the occupied frontline so the vector points from hostile territory towards the target.

Example 2: "БпЛА по межі Сумщини і Харківщини в напрямку Полтавщини (вектор - Котельва/Опішня)"
- CURRENT LOCATION: ON THE BORDER of Sumy/Kharkiv oblasts → origin (~50.0°N, 34.0°E); do NOT place it in a different oblast
- TARGET: "в напрямку Полтавщини (вектор - Котельва/Опішня)" → Kotelva/Opishnia (~50.0°N, 34.5°E); "в напрямку [область]" = heading TOWARDS it, not inside it — entry vectors do not apply when the location is explicit
- Bearing: ~135° (south-east)

Example 3: "🛵 БпЛА над Сумською областю, курс на Полтавщину"
- ORIGIN: "над Сумською областю" = OVER Sumy oblast (~50.3°N, 34.0°E) — explicit position, do NOT use an inferred origin
- TARGET: "курс на Полтавщину" → Poltava oblast (~49.5°N, 34.5°E)
- Bearing: ~160° (south)

Example 4: "Каб з півночі Харківщини по Слов'янську"
- ORIGIN: "з півночі Харківщини" → north of Kharkiv oblast (~49.5°N, 37.6°E)
- TARGET: "по Слов'янську" = AT Sloviansk (~48.9°N, 37.6°E) — "по [місто]" = the city itself
- Bearing: ~180° (south)

Example 5: "🏍 Реактивний БпЛА в на межі Житомирської та Київської областей курс південний."
- threat_kind: uav ("Реактивний БпЛА" = jet UAV); "курс південний" NAMES THE DIRECTION OF MOVEMENT — origin→target and bearing MUST point SOUTH
- ORIGIN: stated location (~50.25°N, 29.55°E); TARGET: a point ~70 km SOUTH along the 180° line (~49.55°N, 29.55°E) — NOT Kyiv (that lies NORTH-EAST, the opposite way)
- Bearing: 180° — exactly the named course; a named compass course is NOT a destination, the target lies ON the named bearing

Example 6: "Київ: 🛵 Реактивний БпЛА в напрямку міста" (SHORT APPROACH ARC; same for "на Жуляни" → target = Zhuliany ~50.40°N, 30.45°E)
- SECTION HEADER "Київ:" = the UAV is ALREADY inside Kyiv oblast, closing in on the city
- TARGET: Kyiv city (~50.45°N, 30.52°E)
- ORIGIN (inferred): ~45 km NORTH-EAST of the target INSIDE Kyiv oblast (~50.72°N, 30.88°E), on the Bryansk/Shatalovo approach bearing — NOT Shatalovo itself (~450 km away)
- Bearing: ~215° (south-west, into the city)
- CRITICAL: launch origins define the DIRECTION of the arc, not its START — an approach report means the drone is minutes from the target, the arc must be short and start inside the section-header oblast.

TERMINOLOGY (monitoring channel slang → threat_kind):
- uav: "Бандеролі" / "Бандероль", "реактив" / "реактиви" / "реактивний" = jet-powered UAV (even without the word "БпЛА"; "реактиви" are NOT missiles)
- missile: "мгКР" / "КР" / "крилаті ракети", "Увага по крилатим ракетам", "Швидкісна ціль" (high-speed target)
- ballistic: "балістична ракета" / "балістика" / "загроза балістичного удару" / "пуски балістики"; "Іскандер" / "Кинджал" / "Циркон" / "KN-23"
- tactical_aviation: "тактична авіація"; takeoffs "МіГ-31(К)", "Ту-22М3", "Ту-95", "Ту-160", "Су-34/25/35"; "ракетна небезпека" / "ракетна загроза" / "ракета-носій" / "авіаційна ракета" with aircraft context
- CRITICAL PRIORITY RULE: an aircraft takeoff ("зліт МіГ-31К", "зліт Ту-22М3", "зліт Су-34" etc.) = "tactical_aviation" EVEN IF the message also mentions "ракетна" / "Кинджал" / "ракета" — the aircraft is the threat carrier. Classify as "missile" only when cruise missiles are explicitly reported in flight ("КР у повітрі", "крилата ракета на маршруті") WITHOUT an aircraft takeoff context.
- "дорозвідка" = reconnaissance, NOT a threat — NEVER emit a threat object for a recon mention alone ("Київ дорозвідка", "дорозвідка до відбою", "дорозвідка по Бандеролях"); in a mixed post (recon + strike report) quote and emit ONLY the strike lines
- Emoji "🅿️" (threat position/update) and "🔄" (maneuvering) = formatting, not content
- "Уважно до відбою" / "дорозвідка до відбою" = the threat remains active until all-clear — NOT a cancellation; "зараз чисто" / "чисто" = all-clear → action "clear"

COORDINATE REQUIREMENTS:
- Provide correct WGS84 coordinates directly in origin_lat/lng and target_lat/lng; they are validated server-side against origin_hint/target_hint/region_hint and MUST match the named places
- NOT confident in exact coordinates (ambiguous or same-named toponym, uncertain oblast) → output NULL for that point, the server resolves it from your hints; otherwise approximate region/city center coordinates are acceptable. NEVER fabricate precise-looking coordinates, NEVER use 0.0, 0.0
- If both origin and target are specified, they MUST be different coordinates (>1 km apart)
- Same-named towns are common (Васильківка vs Василівка, Кам'янка, Новомиколаївка): coordinates must match the place named in the text AND be consistent with the section header oblast; when unsure between two same-named places, prefer the one inside the header oblast

GEOPOLITICAL INFERENCE RULES (when origin/direction is not explicitly stated):

GLOBAL INVARIANT (applies to EVERY threat, no exceptions):
- Incoming threats NEVER fly from unoccupied Ukraine TOWARDS Russia, Belarus, occupied territories or out to the sea. The origin→target vector must always point AWAY from hostile territory, INTO Ukraine (or deeper along the front, away from it). A vector that starts inside unoccupied Ukraine and points toward the border / Russia / occupied territories is ALWAYS WRONG — the origin belongs on the hostile side.
- An explicitly reported current position inside Ukraine IS a valid origin: "БпЛА над Днепром в напрямку Кам'янського" → origin = Dnipro (~48.47°N, 35.04°E), target = Kamianske (~48.51°N, 34.60°E), origin_inferred = FALSE. Movement deeper into Ukraine (away from the front) is correct and must not be "corrected".
- An INFERRED origin (not explicitly reported) must NEVER be a distant point deep inside unoccupied Ukraine — no oblast centers, raion centers or Ukrainian cities. "Ракета на схід Харківщини" → inferred origin is NORTH of the target (Belgorod/Yeysk direction, ~50.4°N, 36.3°E), vector points south INTO the oblast; NOT Kharkiv city and NOT any point west of the target. "Чернігівщина: БпЛА курсом на Холми" → inferred origin is NORTH-EAST of Kholmy (Kursk/Halino direction, ~51.75°N, 36.30°E — the vector points WEST into Ukraine), NOT Chernihiv oblast center.
- EXCEPTION (rule 4, SHORT APPROACH ARC): when the message reports the threat already closing in on a specific place, the inferred origin is a point 40-80 km from the target on the approach bearing — it represents the drone's current approach position, not a launch site, and MAY lie inside unoccupied Ukraine.

APPROACH DIRECTIONS BY TARGET REGION (shared by rules 1-4):
- Zaporizhzhia oblast: from SOUTH (occupied south, ~46.8°N, 35.5°E)
- Dnipropetrovsk oblast: from EAST/SOUTH-EAST (occupied Zaporizhzhia/Donetsk frontline, ~47.6°N, 36.7°E); border entry ~48.5°N, 36.5°E
- Kharkiv oblast: from NORTH (Belgorod direction, ~50.4°N, 36.3°E); border entry ~50.0°N, 36.5°E
- Sumy oblast: from NORTH/EAST; border entry ~51.0°N, 34.5°E
- Chernihiv oblast: from NORTH (Russia/Belarus direction)
- Kyiv oblast/city: from NORTH/NORTH-EAST (Bryansk/Shatalovo direction, rule 3)
- Poltava oblast: from EAST (~49.5°N, 35.5°E)
- Odesa/Mykolaiv/Kherson: from SOUTH (Crimea/Black Sea, ~45.5°N, 31.5°E)

1. KAB/Missile targeting an OBLAST (not a specific city), direction not stated → place the target at the oblast's border entry point facing the approach direction (use the oblast center only as a last resort); target_hint MUST be the oblast name (e.g. "Дніпропетровська область"), NEVER an invented city — border entry points are approximate direction markers, not precise impact points. If the threat targets a CITY, use city coordinates.
2. UAV with NO stated origin/current location → inferred origin = a point on the matching approach direction above (occupied/hostile side). An explicit current location ("над X", "по межі X і Y", "в районі X", "біля X") overrides this entirely — use the stated place. RIGHT: "БпЛА на Полтавщині" (no origin stated) → origin from EAST (~49.5°N, 35.5°E). WRONG: "БпЛА по межі Сумщини і Харківщини в напрямку Полтавщини" → origin on the Sumy/Kharkiv border (~50.0°N, 34.0°E), NOT the Poltava entry vector.
3. KNOWN LAUNCH ORIGINS (Russia/occupied Crimea):
   - Халино, Курськ (~51.75°N, 36.30°E): main airbase for northern/central Ukraine; entry through Sumy heading S/SW — Sumy, Chernihiv, Kyiv, Poltava
   - Шаталово, Смоленська обл. (~54.33°N, 32.07°E): northern hub fanning SOUTH over Kyiv/Chernihiv/Sumy/Poltava and deep WEST (Cherkasy, Kirovohrad, Vinnytsia, Khmelnytskyi, Rivne, Odesa) — default for long-range central/western targets
   - Дронопорт на Брянщині (~53.0°N, 35.0°E): Shaheds SOUTH into Chernihiv/Sumy/northern Kyiv oblast
   - Єйськ, Краснодарський край (~46.68°N, 38.21°E): from E/NE over the Sea of Azov — Kharkiv, Sumy, Poltava, Dnipropetrovsk
   - Міллерово, Ростовська обл. (~48.95°N, 40.40°E): ballistic / X-101 from the EAST — Kharkiv, Dnipro, Zaporizhzhia
   - Приморсько-Ахтарськ (~46.05°N, 38.20°E): Shaheds over the Black Sea — Odesa, Mykolaiv, Kherson, Zaporizhzhia, Dnipro, Kirovohrad, Vinnytsia
   - Мис Чауда, Крим (~44.86°N, 35.42°E): from occupied Crimea — Odesa, Mykolaiv, Kherson; northbound Kirovohrad/Vinnytsia
   - Новоросійськ (~44.72°N, 37.77°E): sea-launched «Калібр» from the SOUTH — Odesa, Mykolaiv, Kherson, western Ukraine
   These launch origins define the DIRECTION of approach. Use a launch site's own coordinates as the inferred origin ONLY when the message reports the launch or the entry into Ukraine itself ("пуски", "зліт", "зі сторони X", "з акваторії", "з боку РФ"); for approach reports apply rule 4.
4. SHORT APPROACH ARC (threat already closing in on a specific place) — the default for approach reports:
   - Applies when the message reports the threat already heading to/onto a specific place ("БпЛА на Жуляни", "реактивний БпЛА в напрямку міста", "курсом на X") and no origin is explicitly stated. Such a report means the threat is ALREADY deep inside Ukraine, minutes from the target — a 300-500 km arc from Shatalovo/Yeysk/Bryansk to the target is WRONG.
   - Take the matching approach direction (list above / rule 3) as the DIRECTION only: place the inferred origin 40-80 km from the target on the REVERSE of that approach bearing, so the short arc keeps the real-world direction.
   - When a SECTION HEADER names the oblast and the target lies in the same oblast, the origin MUST stay inside that oblast ("Київ: ... в напрямку міста" → origin inside Kyiv oblast).
   - Still mark origin_inferred = true (the exact point is an inference; the direction is what matters).

ORIGIN INFERENCE MARKER (origin_inferred) — REQUIRED in every threat object:
- FALSE = the message explicitly states WHERE the threat IS or comes FROM as a NAMED PLACE ("над X", "в районі X", "біля X", "по межі X і Y", "з X"/"від X" with a named place, "в акваторії Чорного моря"). Never guess when the location is stated — that place IS the origin.
- TRUE = the origin was GUESSED by inference: occupied-territory guesses, regional entry vectors, launch origins, direction-only phrases ("з півночі", "з півдня"), short approach arcs (rule 4).

LOCATION RESOLUTION PRIORITY (single authority — apply in this order, stop at first match):

0. EXPLICIT COMPASS COURSE ("курс південний" / "рух на схід" etc.) NAMES THE DIRECTION OF MOVEMENT:
   - The direction FROM origin TO target MUST follow the named bearing; movement_bearing_deg MUST equal the named compass direction (North=0, NE=45, East=90, SE=135, South=180, SW=225, West=270, NW=315). An origin→target direction pointing anywhere else is WRONG, even if some region center lies that way.
   - If the current location is also stated: origin = stated location; target = a point 60-100 km from it ALONG the named bearing.
   - NEVER replace the named course with an entry vector, an oblast center, or a city in a different direction.

1. EXPLICIT CURRENT LOCATION ("над X", "в районі X", "біля X", "по межі X і Y") → origin = the stated place; entry vectors and launch origins do NOT apply.
2. EXPLICIT ORIGIN ("з X" / "із X" / "від X" with a named place) → origin = X. Compass directions ("з півночі", "з півдня") are NOT explicit origins → rule 3.
3. DIRECTIONAL PHRASES ("з півночі" = from north, "з півдня" = from south) → infer from that side of the target, origin_inferred = TRUE.
4. Fallback: approach direction by target region (GEOPOLITICAL rules 1-2). Approach reports with no stated origin ("в напрямку міста", "на Жуляни", "курсом на X") → SHORT APPROACH ARC (GEOPOLITICAL rule 4): origin 40-80 km from the target on the approach bearing, never the distant launch site.

BEARING CALCULATION:
- movement_bearing_deg = direction FROM origin TO target (0-360 degrees). Example: Black Sea (45.0°N, 31.0°E) → Odesa (46.5°N, 30.7°E) ≈ 320°
- CRITICAL: when the message names a compass course, movement_bearing_deg MUST be the NAMED compass value — the target is chosen to lie on that bearing, never pick a target first and let the bearing drift away from the named course.

OTHER RULES:
- Combine context from multiple lines if they describe the same event
- If one post describes several simultaneous threats, return one threat object per independently trackable threat
- "в сектор X / Y" = maneuvering in the area of those towns → origin = their midpoint, target = null
- Action: "new" for new threats, "update" for updates, "clear" for cancellations/destroyed (Відбій, Збито, Чисто)
- Confidence calibration (set honestly per threat):
  * 0.9–1.0: explicit named place(s), coordinates certain, unambiguous text
  * 0.7–0.9: clear region/city, minor uncertainty about exact position
  * 0.4–0.7: inferred origin (entry vector, occupied-territory guess), ambiguous or same-named toponym, approximate coordinates
  * 0.1–0.4: unclear or fragmented text, significant guessing involved
- region_hint = official Ukrainian name of the oblast this threat line belongs to (take it from the SECTION HEADER, e.g. "Харківська область"); null only if the post has no regional context at all
- All hints (region_hint, origin_hint, target_hint, direction_text) must be in Ukrainian only

SOURCE EXCERPT (per-threat quote):
- source_excerpt = the EXACT verbatim quote of ONLY the part of the target message that describes this specific threat (keep emojis, punctuation and line breaks as-is)
- When one post contains several threats (multiple lines/bullets), each threat object must quote ONLY its own line/fragment — never the whole message, never fragments of other threats
- If the entire message describes a single threat, quote the entire message text
- Do not translate, rephrase or summarize — quote the original text

Return strict JSON only with this schema:
{"threats":[{"action":"new|update|clear","threat_kind":"uav|kab|missile|ballistic|tactical_aviation|unknown","confidence":0.0,"region_hint":"string|null","origin_hint":"string|null","target_hint":"string|null","direction_text":"string|null","origin_inferred":false,"origin_lat":null,"origin_lng":null,"target_lat":null,"target_lng":null,"movement_bearing_deg":null,"source_excerpt":"string|null"}]}
No markdown, no comments, no extra keys.`;

  return `${promptText}\n\nText: ${messageText}`;
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

export function getThreatTtlMinutes(threatKind: 'uav' | 'kab' | 'missile' | 'ballistic' | 'tactical_aviation' | 'unknown', hasTarget: boolean) {
  // Threat visibility windows: UAVs and tactical aviation are slow-moving and
  // stay on the map longer; missiles/KABs are short-lived; ballistic is very fast.
  if (threatKind === 'uav') {
    return 35;
  }
  if (threatKind === 'tactical_aviation') {
    return 45;
  }
  if (threatKind === 'ballistic') {
    return 20;
  }
  return 30; // kab, missile, unknown
}

export function isTimeoutLlmFailure(errorMessage: string | null | undefined) {
  const normalized = (errorMessage ?? '').toLowerCase();
  return normalized.includes('timeout') || normalized.includes('timed out') || normalized.includes('aborted');
}

export function isRetriableLlmFailure(responseStatus: number | null, errorMessage: string | null | undefined) {
  if (responseStatus !== null) {
    // A response status can be present even for a timeout: headers may arrive
    // (e.g. HTTP 200) before AbortSignal aborts the body read. Such failures
    // must remain retriable.
    return (
      responseStatus === 408 ||
      responseStatus === 409 ||
      responseStatus === 425 ||
      responseStatus === 429 ||
      responseStatus >= 500 ||
      isTimeoutLlmFailure(errorMessage)
    );
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

export function getLlmRetryDelayMs(retryAttempt: number, baseDelayMs: number, maxDelayMs = 10_000) {
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
    private readonly cacheService: CacheService,
    private readonly alertsService: AlertsService,
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

        const parsedCandidates = await this.parseWithGemini(job.job_id, attemptCount, job.message_text, job.raw_message_id);

        // Защита в глубину: даже если LLM вернул объект угрозы по строке с
        // «дорозвідка» (смешанный пост), чистые дорозвідка-цитаты отбрасываем
        const candidates = parsedCandidates.filter(
          (candidate) => !isReconOnlyReport(candidate.source_excerpt ?? ''),
        );
        if (parsedCandidates.length > candidates.length) {
          this.logger.log(
            `Job ${job.job_id}: dropped ${parsedCandidates.length - candidates.length} recon-only candidate(s)`,
          );
        }

        if (candidates.length === 0) {
          await this.markJobFailed(job.job_id, 'No candidates were extracted by parser.', true);
          failedJobs += 1;
          continue;
        }

        const persistResult = await this.databaseService.withTransaction(async (client) => {
          return this.persistCandidates(client, job, candidates);
        });

        // Cache invalidation runs AFTER the transaction commits so API readers
        // never observe pre-commit state.
        if (persistResult.overlays_created > 0) {
          await this.invalidateThreatCaches(persistResult.overlays_created);
        }
        if (persistResult.runtime_events_applied > 0) {
          await this.alertsService.refreshCachesAfterStateChange(
            null,
            [],
            `telegram_llm job=${job.job_id}`,
          );
        }

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
          AND tmr.message_date > NOW() AT TIME ZONE 'Europe/Kyiv' - INTERVAL '1 hour'
          -- чистые «дорозвідка»-отчёты (без признаков реальной угрозы) в LLM не отправляем;
          -- смешанные посты (дорозвідка + мгКР/ракеты/...) анализируются как обычно
          AND NOT (
            tmr.message_text ILIKE '%дорозвідк%'
            AND tmr.message_text !~* 'мгКР|крилат|ракет|баліст|іскандер|кинджал|циркон|шахед|пуски?|удар|увага по|міг-31|ту-22|ту-95|ту-160|су-34|су-25|су-35|зліт|авіац|реактив|вибух|🅿'
          )
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

  private async parseWithGemini(jobId: string, attemptCount: number, messageText: string, rawMessageId?: string) {
    const llmTargets = this.buildLlmTargets();
    const maxRequestAttempts = this.getAliasedNumberEnv(['LLM_REQUEST_MAX_ATTEMPTS', 'GEMINI_REQUEST_MAX_ATTEMPTS'], 3);
    const retryBaseDelayMs = this.getAliasedNumberEnv(['LLM_REQUEST_RETRY_DELAY_MS', 'GEMINI_REQUEST_RETRY_DELAY_MS'], 1_500);
    const timeoutMs = this.getAliasedNumberEnv(['LLM_TIMEOUT_MS', 'GEMINI_TIMEOUT_MS'], 30_000);
    const prompt = buildGeminiThreatPrompt(messageText);
    let lastError: unknown = null;

    for (let targetIndex = 0; targetIndex < llmTargets.length; targetIndex += 1) {
      const baseTarget = llmTargets[targetIndex]!;
      let activeTarget = baseTarget;
      let requestAttemptLimit = maxRequestAttempts;
      // Timeout failures get exactly one retry per provider target; a second
      // timeout moves on to the next provider (fallback) immediately.
      let timeoutRetryUsed = false;
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
            .map((item) => this.sanitizeCandidate(item, messageText))
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
            isRetriableLlmFailure(responseStatus, parseErrorText);
          if (shouldRetryCurrentTarget && isTimeoutLlmFailure(parseErrorText)) {
            if (timeoutRetryUsed) {
              shouldRetryCurrentTarget = false;
            } else {
              timeoutRetryUsed = true;
            }
          }
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

        const retryDelayMs = getLlmRetryDelayMs(requestAttempt, retryBaseDelayMs);
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
    const deepseekApiKey = this.toNullableString(this.configService.get<string>('DEEPSEEK_API_KEY'));
    const grokApiKey = this.toNullableString(this.configService.get<string>('GROK_API_KEY'));
    const geminiApiKey = this.toNullableString(this.configService.get<string>('GEMINI_API_KEY'));

    if (deepseekApiKey) {
      targets.push({
        provider: 'deepseek',
        model: this.configService.get<string>('DEEPSEEK_MODEL') ?? 'deepseek-v4-flash',
        apiKey: deepseekApiKey,
      });
    }

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
      throw new Error('No LLM API key is configured. Set DEEPSEEK_API_KEY, GROK_API_KEY or GEMINI_API_KEY.');
    }

    return targets;
  }

  private buildLlmRequestPayload(target: LlmTarget, prompt: string) {
    // Reasoning/thinking is disabled by default: for short threat-extraction
    // prompts reasoning tokens made up ~95% of billed completion tokens.
    // Set LLM_THINKING_ENABLED=true to re-enable provider reasoning.
    const thinkingEnabled = this.configService.get<string>('LLM_THINKING_ENABLED') === 'true';

    if (target.provider === 'grok' || target.provider === 'deepseek') {
      const payload: Record<string, unknown> = {
        model: target.model,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0.1,
        // Cap runaway completions; when thinking is enabled reasoning tokens
        // also count against max_tokens, so the cap must stay generous.
        max_tokens: thinkingEnabled ? 8192 : 1500,
        response_format: {
          type: 'json_object',
        },
      };

      if (!thinkingEnabled) {
        if (target.provider === 'deepseek') {
          payload.thinking = { type: 'disabled' };
        } else {
          payload.reasoning_effort = 'low';
        }
      }

      return payload;
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
        maxOutputTokens: thinkingEnabled ? 8192 : 1536,
        ...(thinkingEnabled ? {} : { thinkingConfig: { thinkingBudget: 0 } }),
      },
    };
  }

  private getLlmEndpoint(target: LlmTarget) {
    if (target.provider === 'deepseek') {
      return 'https://api.deepseek.com/chat/completions';
    }

    if (target.provider === 'grok') {
      return 'https://api.x.ai/v1/chat/completions';
    }

    return `https://generativelanguage.googleapis.com/v1beta/models/${target.model}:generateContent?key=${target.apiKey}`;
  }

  private getLlmHeaders(target: LlmTarget) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (target.provider === 'deepseek' || target.provider === 'grok') {
      headers.Authorization = `Bearer ${target.apiKey}`;
    }

    return headers;
  }

  private parseLlmCandidates(target: LlmTarget, responseBody: string) {
    const textPayload = target.provider === 'deepseek' || target.provider === 'grok'
      ? this.extractOpenaiTextPayload(responseBody)
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

  private extractOpenaiTextPayload(responseBody: string) {
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
      throw new Error('OpenAI-compatible API returned no text payload.');
    }

    return textPayload;
  }

  private describeLlmTarget(target: LlmTarget) {
    if (target.provider === 'deepseek') return 'DeepSeek';
    if (target.provider === 'grok') return 'Grok';
    return 'Gemini';
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

  private sanitizeCandidate(candidate: ParseCandidate | null | undefined, messageText?: string) {
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
      source_excerpt: this.sanitizeSourceExcerpt(candidate.source_excerpt, messageText),
      origin_inferred: candidate.origin_inferred === true,
    };

    // Validate coordinates and log warnings for suspicious patterns
    return this.validateAndCorrectCoordinates(sanitized);
  }

  private sanitizeSourceExcerpt(excerpt: string | null | undefined, messageText?: string): string | null {
    const cleaned = this.toNullableString(excerpt)?.trim();
    if (!cleaned) {
      return null;
    }

    const trimmed = cleaned.slice(0, 500);
    if (!messageText) {
      return trimmed;
    }

    // Accept only verbatim quotes from the parsed message; if the LLM paraphrased,
    // drop the excerpt so the client falls back to the full message text.
    const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
    if (!normalize(messageText).includes(normalize(trimmed))) {
      return null;
    }

    return this.prependMessageHeaderTitle(trimmed, messageText);
  }

  /**
   * Multi-threat messages like "Ситуація по реактивних БпЛА:\n- <line>\n- <line>"
   * are split by the LLM into per-line excerpts that lose the section header.
   * Restore a short title so the client popup shows e.g.
   * "Реактивний БпЛА:\n- на заході Харківщини, курс на Полтавщину;".
   */
  private prependMessageHeaderTitle(excerpt: string, messageText: string): string {
    const title = this.deriveMessageHeaderTitle(messageText, excerpt);
    if (!title) {
      return excerpt;
    }

    return `${title}\n${excerpt}`.slice(0, 500);
  }

  private deriveMessageHeaderTitle(messageText: string, excerpt: string): string | null {
    const lines = messageText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (lines.length < 2) {
      return null;
    }

    const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
    const headerLine = lines[0]!;
    // Excerpt already contains the header (e.g. single-threat full-message quote).
    if (normalize(excerpt).includes(normalize(headerLine))) {
      return null;
    }

    // Strip leading emoji/symbols; a section header must end with ':'.
    const headerCore = headerLine
      .replace(/^[^\p{L}\p{N}]+/u, '')
      .replace(/[\s\p{Extended_Pictographic}\uFE0F]+$/u, '')
      .trim();
    if (!headerCore.endsWith(':')) {
      return null;
    }

    const headerBody = headerCore.slice(0, -1).trim();
    const strippedBody = headerBody
      .replace(/^(?:ситуація|обстановка|інформація|дані)\s+(?:станом\s+на|по|щодо|про)\s+/iu, '')
      .trim();

    const normalizedTitle = THREAT_HEADER_TITLE_MAP.find(([pattern]) => pattern.test(strippedBody));
    if (normalizedTitle) {
      return normalizedTitle[1];
    }

    // Unknown header wording: keep it verbatim rather than risk broken grammar.
    return headerCore;
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
    let runtimeEventsApplied = 0;

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

      // Deterministic geopolitical sanity check: an INFERRED origin must never
      // lie DEEP inside unoccupied Ukraine (incoming threats only fly from
      // Russia / occupied territories / the sea inward). Re-anchor it to the
      // nearest hostile border exit when the LLM still placed it inside.
      // Short approach arcs (<90 km from the target) are exempt — there the
      // origin is the threat's current approach position, not a launch site.
      if (
        candidate.action === 'new' &&
        candidate.origin_inferred === true &&
        this.areValidCoordinates(originLat, originLng) &&
        this.areValidCoordinates(targetLat, targetLng)
      ) {
        try {
          const reanchored = await this.reanchorInferredOriginIfInsideUkraine(
            client,
            originLat,
            originLng,
            targetLat,
            targetLng,
          );
          if (reanchored) {
            originLat = reanchored.latitude;
            originLng = reanchored.longitude;
            candidate.origin_lat = reanchored.latitude;
            candidate.origin_lng = reanchored.longitude;
            candidate.movement_bearing_deg = null; // recompute below from the new origin
            candidate.origin_reanchored = true;
          }
        } catch (error) {
          this.logger.warn(`Inferred-origin re-anchor check failed: ${this.stringifyError(error)}`);
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
              SET status = 'archived',
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

      this.logger.debug(
        `Insert threat vector check: vectorId=${vectorId} rawMessageId=${job.raw_message_id} occurredAt=${occurredAt.toISOString()} expiresAt=${expiresAt.toISOString()} originUid=${origin?.uid ?? null} targetUid=${target?.uid ?? null} hasTargetCoords=${hasTargetCoordinates} hasTargetRegion=${hasTargetRegion}`
      );

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
            source_excerpt,
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
            $21,
            $22::jsonb,
            $23,
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
          candidate.source_excerpt,
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
        runtimeEventsApplied += 1;
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

    // Threat/alert cache invalidation is done by the caller after the
    // enclosing transaction commits.

    return {
      overlays_created: overlaysCreated,
      runtime_events_applied: runtimeEventsApplied,
    };
  }

  private async invalidateThreatCaches(overlaysCreated: number) {
    try {
      // Bucket keys carry a sources suffix (threats:<bucketTs>:<sources>) and
      // bbox variants (threats:<bbox>) — drop them all by pattern, plus the
      // standalone threat bundle.
      await this.cacheService.deleteByPattern('threats:*');
      await this.cacheService.delete(CACHE_KEYS.THREAT_BUNDLE);
      await this.cacheService.publish(CACHE_CHANNELS.THREATS_UPDATED, {
        overlays_created: overlaysCreated,
        timestamp: Date.now(),
      });
      this.logger.debug(`Threats cache invalidated: ${overlaysCreated} new overlays`);
    } catch (error) {
      this.logger.warn(`Failed to invalidate threats cache: ${error}`);
    }
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
    if (normalized.includes('ballistic') || normalized.includes('балістичн')) {
      return 'ballistic';
    }
    if (normalized.includes('tactical_aviation') || normalized.includes('tactical aviation') ||
        (normalized.includes('тактичн') && normalized.includes('авіац'))) {
      return 'tactical_aviation';
    }
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
      case 'ballistic':
      case 'tactical_aviation':
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
      case 'ballistic':
        return 'missile';
      case 'tactical_aviation':
        return 'aviation';
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
      case 'ballistic':
        return '#dc2626';
      case 'tactical_aviation':
        return '#ef4444';
      default:
        return '#6b7280';
    }
  }

  private toPriority(threatKind: ParseCandidate['threat_kind']) {
    switch (threatKind) {
      case 'ballistic':
        return 5;
      case 'tactical_aviation':
        return 8;
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

  private hostileGeomCache: HostileGeometries | null = null;

  /**
   * Ukraine boundary (same union as /map/ukraine-boundary) + occupied
   * territories geometry, cached for 10 minutes. Used by the deterministic
   * geopolitical sanity check for inferred threat origins.
   */
  private async getHostileGeometries(client: PoolClient): Promise<HostileGeometries | null> {
    if (this.hostileGeomCache && Date.now() - this.hostileGeomCache.loadedAt < 10 * 60 * 1000) {
      return this.hostileGeomCache;
    }

    const boundaryResult = await client.query<{ geom_json: string | null }>(
      `
        SELECT ST_AsGeoJSON(
          ST_Buffer(
            ST_Collect(ST_Simplify(rg.geom, 0.01)),
            0
          )
        ) AS geom_json
        FROM region_geometry rg
        JOIN region_catalog rc ON rc.uid = rg.uid
        WHERE rc.is_active = TRUE
          AND rc.region_type = ANY($1::text[])
      `,
      [['oblast', 'city']],
    );

    const ukraineGeoJson = boundaryResult.rows[0]?.geom_json;
    if (!ukraineGeoJson) {
      return null;
    }

    const occupiedGeoJsons: string[] = [];
    const occupiedPath = resolveOccupiedTerritoriesDataPath();
    if (occupiedPath) {
      try {
        const parsed = JSON.parse(fs.readFileSync(occupiedPath, 'utf8'));
        const features = Array.isArray(parsed?.features) ? parsed.features : [];
        for (const feature of features) {
          if (feature?.geometry) {
            occupiedGeoJsons.push(JSON.stringify(feature.geometry));
          }
        }
      } catch (error) {
        this.logger.warn(`Failed to read occupied territories file: ${this.stringifyError(error)}`);
      }
    }

    this.hostileGeomCache = { ukraineGeoJson, occupiedGeoJsons, loadedAt: Date.now() };
    return this.hostileGeomCache;
  }

  /**
   * Deterministic guard for the LLM: an INFERRED origin (no explicitly
   * reported position) must never lie DEEP inside unoccupied Ukraine. When it
   * does, re-anchor it to the nearest hostile border exit on the ray cast
   * backwards from the target along the origin→target bearing.
   * Exception: origins within 90 km of the target are left as-is — a short
   * arc near the target is an approach report ("в напрямку міста"), where the
   * origin represents the threat's current approach position, not a launch site.
   */
  private async reanchorInferredOriginIfInsideUkraine(
    client: PoolClient,
    originLat: number,
    originLng: number,
    targetLat: number,
    targetLng: number,
  ): Promise<{ latitude: number; longitude: number } | null> {
    const geoms = await this.getHostileGeometries(client);
    if (!geoms) {
      return null;
    }

    const check = await client.query<{ needs_reanchor: boolean }>(
      `
        WITH ukr AS (SELECT ST_GeomFromGeoJSON($1) AS geom),
             occ AS (
               SELECT CASE
                        WHEN cardinality($2::text[]) = 0 THEN NULL
                        ELSE ST_Union(ARRAY(SELECT ST_GeomFromGeoJSON(g) FROM unnest($2::text[]) AS g))
                      END AS geom
             ),
             origin_pt AS (SELECT ST_SetSRID(ST_MakePoint($3, $4), 4326) AS geom),
             target_pt AS (SELECT ST_SetSRID(ST_MakePoint($5, $6), 4326) AS geom)
        SELECT
          ST_Covers(ukr.geom, origin_pt.geom)
            AND (occ.geom IS NULL OR NOT ST_Covers(occ.geom, origin_pt.geom))
            AND ST_Covers(ukr.geom, target_pt.geom)
            AND ST_Distance(origin_pt.geom::geography, target_pt.geom::geography) > 90000 AS needs_reanchor
        FROM ukr, occ, origin_pt, target_pt
      `,
      [geoms.ukraineGeoJson, geoms.occupiedGeoJsons, originLng, originLat, targetLng, targetLat],
    );

    if (!check.rows[0]?.needs_reanchor) {
      return null;
    }

    const reverseBearing = Math.round(
      (this.calculateBearing(originLat, originLng, targetLat, targetLng) + 180) % 360,
    );
    const exit = await this.findHostileExit(client, geoms, targetLat, targetLng, reverseBearing);
    if (!exit) {
      this.logger.warn(
        `Inferred origin (${originLat},${originLng}) is inside unoccupied Ukraine but no hostile exit found from target (${targetLat},${targetLng}); keeping LLM coordinates`,
      );
      return null;
    }

    const anchor = this.destinationPoint(targetLat, targetLng, exit.azimuthDeg, exit.distanceMeters + 10000);
    this.logger.log(
      `Re-anchored inferred origin inside unoccupied Ukraine: (${originLat},${originLng}) -> (${anchor.latitude.toFixed(4)},${anchor.longitude.toFixed(4)}), azimuth=${exit.azimuthDeg}°, exitDistance=${Math.round(exit.distanceMeters / 1000)}km, target=(${targetLat},${targetLng})`,
    );
    return anchor;
  }

  private async findHostileExit(
    client: PoolClient,
    geoms: HostileGeometries,
    targetLat: number,
    targetLng: number,
    reverseBearingDeg: number,
  ): Promise<{ azimuthDeg: number; distanceMeters: number } | null> {
    const query = `
      WITH target_pt AS (SELECT ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography AS g),
           ukr AS (SELECT ST_GeomFromGeoJSON($3) AS geom),
           occ AS (
             SELECT CASE
                      WHEN cardinality($4::text[]) = 0 THEN NULL
                      ELSE ST_Union(ARRAY(SELECT ST_GeomFromGeoJSON(g) FROM unnest($4::text[]) AS g))
                    END AS geom
           ),
           sea AS (SELECT ST_GeomFromText($5, 4326) AS geom),
           rays AS (
             SELECT azimuth_deg,
                    distance_m,
                    ST_Project(target_pt.g, distance_m, radians(azimuth_deg::float8)) AS pt
             FROM target_pt,
                  LATERAL (SELECT mod(($6::int + off * 15) + 720, 360) AS azimuth_deg
                           FROM generate_series(0, $7::int) AS off) az,
                  generate_series(10000, 400000, 15000) AS distance_m
           )
      SELECT azimuth_deg, MIN(distance_m) AS distance_m
      FROM rays, ukr, occ, sea
      WHERE (occ.geom IS NOT NULL AND ST_Covers(occ.geom, rays.pt::geometry))
         OR (
              NOT ST_Covers(ukr.geom, rays.pt::geometry)
              AND (
                    azimuth_deg <= 135
                    OR azimuth_deg >= 270
                    OR ST_Covers(sea.geom, rays.pt::geometry)
                  )
            )
      GROUP BY azimuth_deg
      ORDER BY distance_m ASC,
               LEAST(ABS(azimuth_deg - $8::int), 360 - ABS(azimuth_deg - $8::int)) ASC
      LIMIT 1
    `;

    // Fan ±60° around the reverse bearing first; if nothing hostile is found
    // there (LLM bearing pointed the wrong way), fall back to a full sweep.
    const fan = await client.query<{ azimuth_deg: number; distance_m: string }>(
      query,
      [targetLng, targetLat, geoms.ukraineGeoJson, geoms.occupiedGeoJsons, HOSTILE_SEA_WKT, reverseBearingDeg - 60, 8, reverseBearingDeg],
    );
    let row = fan.rows[0];
    if (!row) {
      const sweep = await client.query<{ azimuth_deg: number; distance_m: string }>(
        query,
        [targetLng, targetLat, geoms.ukraineGeoJson, geoms.occupiedGeoJsons, HOSTILE_SEA_WKT, 0, 23, reverseBearingDeg],
      );
      row = sweep.rows[0];
    }

    return row ? { azimuthDeg: Number(row.azimuth_deg), distanceMeters: Number(row.distance_m) } : null;
  }

  private destinationPoint(lat: number, lng: number, bearingDeg: number, distanceMeters: number) {
    const radius = 6371000;
    const angular = distanceMeters / radius;
    const bearing = (bearingDeg * Math.PI) / 180;
    const lat1 = (lat * Math.PI) / 180;
    const lng1 = (lng * Math.PI) / 180;
    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(angular) + Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing),
    );
    const lng2 =
      lng1 +
      Math.atan2(
        Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1),
        Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2),
      );
    return {
      latitude: (lat2 * 180) / Math.PI,
      longitude: ((((lng2 * 180) / Math.PI) + 540) % 360) - 180,
    };
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
