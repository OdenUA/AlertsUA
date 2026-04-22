// Global variables and constants for Alerts UA leaflet map
var statusElement = null;
var map = null;

var apiBaseUrl = 'http://10.0.2.2:43100/api/v1';
var tileLayer = null;
var activeConfig = null;
var ukraineMaskLayer = null;
var alertMarkersLayer = null;
var specialAlertLayer = null;
var threatOverlayLayer = null;
var threatOverlayData = [];
var activeAlertsLayer = null;
var hasFittedToData = false;
var overlayLayers = {
    oblast: null,
    raion: null,
    hromada: null,
};
var refreshTimerId = null;
var ukraineBoundaryGeometry = null;
var mapReady = false;
var mapReadyQueue = [];
var subscriptionMarkers = {};
var INITIAL_FIT_ZOOM_STEP = 1;

var statusPalette = {
    'A': '#d7263d',
    'P': '#2a9d8f',
    'N': '#2a9d8f',
    ' ': '#4d6a77',
};

var alertTypePalette = {
    air_raid: {
        stroke: '#d7263d',
        fill: '#d7263d',
        fillOpacity: 0.25,
    },
    artillery_shelling: {
        stroke: '#f08c00',
        fill: '#ffb347',
        fillOpacity: 0.42,
    },
    urban_fights: {
        stroke: '#7b2cbf',
        fill: '#b47aea',
        fillOpacity: 0.45,
    },
};

// Alert type icon paths (relative to this HTML file)
var ALERT_TYPE_ICONS = {
    air_raid:            'file:///android_asset/leaflet/icons/air-raid.png',
    artillery_shelling:  'file:///android_asset/leaflet/icons/artillery-shelling.png',
    urban_fights:        'file:///android_asset/leaflet/icons/urban-fights.png',
};
var ALERT_ICON_FALLBACK = 'file:///android_asset/leaflet/icons/air-raid.png';

var THREAT_TYPE_ICONS = {
    uav: {
        light: 'file:///android_asset/leaflet/icons/shahed-light.png',
        dark: 'file:///android_asset/leaflet/icons/shahed-dark.png',
    },
    kab: {
        light: 'file:///android_asset/leaflet/icons/kab-black.png',
        dark: 'file:///android_asset/leaflet/icons/kab-grey.png',
    },
    missile: {
        light: 'file:///android_asset/leaflet/icons/missile-black.png',
        dark: 'file:///android_asset/leaflet/icons/missile-grey.png',
    },
    unknown: {
        light: 'file:///android_asset/leaflet/icons/air-raid.png',
        dark: 'file:///android_asset/leaflet/icons/air-raid.png',
    },
};

const THREAT_DIRECTION_MIN_DISTANCE_METERS = 50000;
const THREAT_DIRECTION_ARC_SEGMENTS = 18;
const THREAT_DIRECTION_ARC_MIN_OFFSET_PX = 12;
const THREAT_DIRECTION_ARC_MAX_OFFSET_PX = 30;
const THREAT_DIRECTION_COLOR = '#4285f4';
const THREAT_DIRECTION_ZOOM_BASE = 7;
const THREAT_DIRECTION_ZOOM_SCALE_STEP = 0.18;
const THREAT_DIRECTION_BASE_LINE_WEIGHT = 5;
const THREAT_DIRECTION_MIN_LINE_WEIGHT = 3;
const THREAT_DIRECTION_MAX_LINE_WEIGHT = 7;
const THREAT_DIRECTION_BASE_ARROW_LENGTH_PX = 18;
const THREAT_DIRECTION_MIN_ARROW_LENGTH_PX = 12;
const THREAT_DIRECTION_MAX_ARROW_LENGTH_PX = 24;
const THREAT_DIRECTION_BASE_ARROW_WIDTH_PX = 10;
const THREAT_DIRECTION_MIN_ARROW_WIDTH_PX = 6;
const THREAT_DIRECTION_MAX_ARROW_WIDTH_PX = 14;
const THREAT_MARKER_TAP_TARGET_PX = 40;

const THREAT_POPUP_SENDER = 'Повітряні Сили ЗС України';
const THREAT_LAYER_TELEGRAM_ICON_MARKUP = [
    '<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">',
    '<path fill="#273757" d="M0,0C39.6,0 79.2,0 120,0C120,39.6 120,79.2 120,120C80.4,120 40.8,120 0,120C0,80.4 0,40.8 0,0Z"/>',
    '<g transform="translate(55 25)">',
    '<path fill="#EB8F04" d="M0,0C3.3,0 6.6,0 10,0C9.99476318,0.96824707 9.98952637,1.93649414 9.98413086,2.93408203C9.965953,6.54588894 9.95452146,10.15769184 9.94506836,13.76953125C9.94005728,15.32910849 9.93324663,16.88868108 9.92456055,18.44824219C9.91235314,20.69727736 9.90673932,22.9462501 9.90234375,25.1953125C9.89718246,25.8861795 9.89202118,26.57704651 9.88670349,27.28884888C9.88624391,31.30611434 10.27790074,35.05370974 11,39C11.02730972,42.13671596 10.93732624,45.25558797 10.83984375,48.390625C10.72078268,51.16242261 10.72078268,51.16242261 13,53C15.66242821,53.46290221 15.66242821,53.46290221 18.625,53.625C19.62789062,53.69976562 20.63078125,53.77453125 21.6640625,53.8515625C22.43492188,53.90054688 23.20578125,53.94953125 24,54C23.71125,53.00742188 23.4225,52.01484375 23.125,50.9921875C19.80194224,39.05609531 17.36189287,26.66008539 23,15C25.19317043,11.1796386 27.19070663,8.28557602 31,6C31.66,6 32.32,6 33,6C33,23.82 33,41.64 33,60C25.74,60 18.48,60 11,60C9.7094938,65.8072779 8.63843072,71.14771843 8,77C6.02,77 4.04,77 2,77C1.68692614,75.29177174 1.37456992,73.58341195 1.0625,71.875C0.88847656,70.92367187 0.71445312,69.97234375 0.53515625,68.9921875C-0.00019283,65.99892185 -0.50010169,62.99938986 -1,60C-8.26,60 -15.52,60 -23,60C-23,42.18 -23,24.36 -23,6C-16.95840088,8.41663965 -14.80042895,11.21641485 -11.75,16.75C-6.79432167,28.58856491 -10.20193266,42.35146312 -14,54C-12.20759337,53.88610125 -10.41605165,53.75852313 -8.625,53.625C-7.62726562,53.55539063 -6.62953125,53.48578125 -5.6015625,53.4140625C-2.84491121,53.23636036 -2.84491121,53.23636036 -1,51C-0.79448259,48.7619956 -0.79448259,48.7619956 -0.9375,46.25C-1.0349669,43.48702516 -1.0131012,41.07015273 -0.50439453,38.34619141C0.08075423,34.46427037 0.1251537,30.67157121 0.09765625,26.7578125C0.0962413,25.98944061 0.09482635,25.22106873 0.09336853,24.42941284C0.08780683,21.99456761 0.0752616,19.55981706 0.0625,17.125C0.05748004,15.46614717 0.05291801,13.80729288 0.04882812,12.1484375C0.03784998,8.0989223 0.02061206,4.04947716 0,0Z"/>',
    '</g>',
    '</svg>'
].join('');
