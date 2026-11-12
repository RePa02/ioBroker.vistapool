'use strict';
/**
 * Controller clock helpers. The controller keeps local wall-clock time and reports it as
 * main.localTime ("local seconds since 1970", i.e. local time encoded like UTC).
 */

/** System time zone of the host (IANA name). */
function systemZone() {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
        return 'UTC';
    }
}

/**
 * True if the zone never differs from UTC (typical for Docker containers without TZ).
 *
 * @param tz
 */
function isUtcZone(tz) {
    const jan = offsetSec(new Date(Date.UTC(2026, 0, 15)), tz);
    const jul = offsetSec(new Date(Date.UTC(2026, 6, 15)), tz);
    return jan === 0 && jul === 0;
}

/**
 * Validates an IANA zone name.
 *
 * @param tz
 */
function isValidZone(tz) {
    try {
        Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

/**
 * Offset of a zone to UTC in seconds at the given instant (CET = 3600, CEST = 7200).
 *
 * @param date
 * @param tz
 */
function offsetSec(date, tz) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    }).formatToParts(date);
    const p = Object.fromEntries(parts.map(x => [x.type, Number(x.value)]));
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 1000);
}

/**
 * Local wall-clock time of the zone as "local epoch seconds" (format of main.localTime).
 *
 * @param date
 * @param tz
 */
function localEpoch(date, tz) {
    return Math.floor(date.getTime() / 1000) + offsetSec(date, tz);
}

module.exports = { systemZone, isUtcZone, isValidZone, offsetSec, localEpoch };
