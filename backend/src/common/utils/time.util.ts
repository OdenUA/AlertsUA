export class TimeUtil {
  static getNowInKyiv(): string {
    return this.toKyivIsoString(new Date());
  }

  static toKyivIsoString(date: Date): string {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Kyiv',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 3,
      hour12: false,
      timeZoneName: 'longOffset',
    }).formatToParts(date);

    const valueByType = new Map(parts.map((part) => [part.type, part.value]));
    const rawOffset = valueByType.get('timeZoneName') ?? 'GMT+00:00';
    const offset = rawOffset.replace('GMT', '');

    return `${valueByType.get('year')}-${valueByType.get('month')}-${valueByType.get('day')}T${valueByType.get('hour')}:${valueByType.get('minute')}:${valueByType.get('second')}.${valueByType.get('fractionalSecond')}${offset}`;
  }
}
