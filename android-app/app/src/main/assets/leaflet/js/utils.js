function setStatus(message) {
    if (!message) {
        statusElement.style.display = 'none';
        return;
    }
    statusElement.textContent = message;
    statusElement.style.display = 'block';
}

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatThreatPopupTime(value) {
    if (!value) {
        return '';
    }

    var date = new Date(value);
    if (!Number.isFinite(date.getTime())) {
        return '';
    }

    // Always use Kyiv timezone for threat popup times
    return date.toLocaleTimeString('uk-UA', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Europe/Kyiv'
    });
}

function buildThreatPopupContent(overlay) {
    // Prefer the per-threat excerpt (verbatim quote of the fragment describing
    // this specific threat); fall back to the full message for older rows.
    var rawMessage = overlay && (overlay.source_excerpt || overlay.message_text);
    var safeMessage = escapeHtml(rawMessage ? rawMessage : '').replace(/\r?\n/g, '<br>');
    var messageTime = formatThreatPopupTime(overlay && (overlay.message_date || overlay.occurred_at));
    var footerParts = ['<span>Telegram</span>'];

    if (messageTime) {
        footerParts.push('<span class="threat-popup-dot"></span>');
        footerParts.push('<span>' + escapeHtml(messageTime) + '</span>');
    }

    return [
        '<div class="threat-popup-card">',
        '  <div class="threat-popup-header">',
        '    <div class="threat-popup-avatar">' + THREAT_LAYER_TELEGRAM_ICON_MARKUP + '</div>',
        '    <div class="threat-popup-meta">',
        '      <div class="threat-popup-author">' + escapeHtml(THREAT_POPUP_SENDER) + '</div>',
        '      <div class="threat-popup-label">Оперативне повідомлення</div>',
        '    </div>',
        '  </div>',
        '  <div class="threat-popup-bubble">',
        '    <div class="threat-popup-message">' + safeMessage + '</div>',
        '    <div class="threat-popup-footer">' + footerParts.join('') + '</div>',
        '  </div>',
        '</div>'
    ].join('');
}

function isSpecialAlertType(alertType) {
    return alertType === 'artillery_shelling' || alertType === 'urban_fights';
}

function clamp(value, minValue, maxValue) {
    return Math.min(maxValue, Math.max(minValue, value));
}