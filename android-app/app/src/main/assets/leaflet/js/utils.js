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

    return date.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
}

function buildThreatPopupContent(overlay) {
    var safeMessage = escapeHtml(overlay && overlay.message_text ? overlay.message_text : '').replace(/\r?\n/g, '<br>');
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