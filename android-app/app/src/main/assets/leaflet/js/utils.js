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

function formatThreatLifetimeText(elapsedMs) {
    var totalMinutes = Math.max(1, Math.round(elapsedMs / 60000));
    if (totalMinutes < 60) {
        return totalMinutes + 'хв';
    }
    var hours = Math.floor(totalMinutes / 60);
    var minutes = totalMinutes % 60;
    return minutes > 0 ? hours + 'год ' + minutes + 'хв' : hours + 'год';
}

function buildThreatLifetimeMarkup(overlay) {
    if (!overlay || !overlay.occurred_at) {
        return '';
    }
    var occurredAt = new Date(overlay.occurred_at).getTime();
    if (!Number.isFinite(occurredAt)) {
        return '';
    }

    // Total lifetime: explicit expires_at when available, otherwise the same
    // fallback visibility window used in renderThreatOverlays (uav 45 min, others 30 min).
    var totalMs = 0;
    if (overlay.expires_at) {
        var expiresAt = new Date(overlay.expires_at).getTime();
        if (Number.isFinite(expiresAt) && expiresAt > occurredAt) {
            totalMs = expiresAt - occurredAt;
        }
    }
    if (!totalMs) {
        totalMs = overlay.threat_kind === 'uav' ? 45 * 60 * 1000 : 30 * 60 * 1000;
    }

    var elapsedMs = Math.max(0, Date.now() - occurredAt);
    var fraction = clamp(elapsedMs / totalMs, 0, 1);

    // Circle icon with a darkened sector proportional to the elapsed fraction.
    var sector;
    if (fraction >= 0.999) {
        sector = '<circle cx="6" cy="6" r="5" class="threat-popup-life-sector"></circle>';
    } else if (fraction <= 0.001) {
        sector = '';
    } else {
        var angle = fraction * 2 * Math.PI;
        var endX = (6 + 5 * Math.sin(angle)).toFixed(2);
        var endY = (6 - 5 * Math.cos(angle)).toFixed(2);
        var largeArc = fraction > 0.5 ? 1 : 0;
        sector = '<path d="M 6 6 L 6 1 A 5 5 0 ' + largeArc + ' 1 ' + endX + ' ' + endY + ' Z" class="threat-popup-life-sector"></path>';
    }

    return [
        '<svg class="threat-popup-life-icon" viewBox="0 0 12 12" aria-hidden="true">',
        '<circle cx="6" cy="6" r="5" class="threat-popup-life-track"></circle>',
        sector,
        '</svg>',
        '<span>' + formatThreatLifetimeText(elapsedMs) + '</span>'
    ].join('');
}

function buildThreatPopupContent(overlay) {
    // Prefer the per-threat excerpt (verbatim quote of the fragment describing
    // this specific threat); fall back to the full message for older rows.
    var rawMessage = overlay && (overlay.source_excerpt || overlay.message_text);
    var safeMessage = escapeHtml(rawMessage ? rawMessage : '').replace(/\r?\n/g, '<br>');
    var messageTime = formatThreatPopupTime(overlay && (overlay.message_date || overlay.occurred_at));
    var channelConfig = getThreatChannelConfig(overlay && overlay.channel_ref);
    var footerParts = ['<span>Telegram</span>'];

    if (messageTime) {
        footerParts.push('<span class="threat-popup-dot"></span>');
        footerParts.push('<span>' + escapeHtml(messageTime) + '</span>');
    }

    return [
        '<div class="threat-popup-card">',
        '  <div class="threat-popup-header">',
        '    <div class="threat-popup-avatar">' + channelConfig.avatar + '</div>',
        '    <div class="threat-popup-meta">',
        '      <div class="threat-popup-author">' + escapeHtml(channelConfig.sender) + '</div>',
        '      <div class="threat-popup-label">Оперативне повідомлення</div>',
        '    </div>',
        '  </div>',
        '  <div class="threat-popup-bubble">',
        '    <div class="threat-popup-message">' + safeMessage + '</div>',
        '    <div class="threat-popup-footer">',
        '      <span class="threat-popup-life">' + buildThreatLifetimeMarkup(overlay) + '</span>',
        '      <span class="threat-popup-source">' + footerParts.join('') + '</span>',
        '    </div>',
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