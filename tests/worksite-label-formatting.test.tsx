import { describe, expect, it } from 'vitest';
import { formatWorkSiteLabel, isEventCode, type WorkSiteOption } from '../src/features/admin-reference-settings/types';

describe('isEventCode', () => {
  it('identifies event codes correctly', () => {
    expect(isEventCode('SITE-EVENT-1C495BA3-FD74-4DCB-8835-B06A44567295')).toBe(true);
    expect(isEventCode('SITE-EVENT-305B76A6-ED33-46C7-BB12-007')).toBe(true);
    expect(isEventCode('EVENT-1C495BA3-FD74-4DCB-8835-B06A44567295')).toBe(true);
    expect(isEventCode('site-event-abc')).toBe(true);
  });

  it('identifies non-event codes correctly', () => {
    expect(isEventCode('SITE-AA')).toBe(false);
    expect(isEventCode('SITE-BB')).toBe(false);
    expect(isEventCode('SITE-SW')).toBe(false);
    expect(isEventCode('TRUCK-01')).toBe(false);
    expect(isEventCode('')).toBe(false);
    expect(isEventCode(null)).toBe(false);
    expect(isEventCode(undefined)).toBe(false);
  });
});

describe('formatWorkSiteLabel', () => {
  it('hides event codes and returns only the event name', () => {
    const eventSite1: WorkSiteOption = {
      id: 'site-4',
      code: 'SITE-EVENT-1C495BA3-FD74-4DCB-8835-B06A44567295',
      name: 'ตึก C · จุดปฏิบัติงาน',
    };
    expect(formatWorkSiteLabel(eventSite1)).toBe('ตึก C · จุดปฏิบัติงาน');

    const eventSite2: WorkSiteOption = {
      id: 'site-5',
      code: 'SITE-EVENT-305B76A6-ED33-46C7-BB12-007',
      name: 'Event ประจำเดือน',
    };
    expect(formatWorkSiteLabel(eventSite2)).toBe('Event ประจำเดือน');
  });

  it('formats regular worksites with code and name', () => {
    const regularSite1: WorkSiteOption = {
      id: 'site-1',
      code: 'SITE-AA',
      name: 'A · จุดปฏิบัติงาน',
    };
    expect(formatWorkSiteLabel(regularSite1)).toBe('SITE-AA · A · จุดปฏิบัติงาน');

    const regularSite2: WorkSiteOption = {
      id: 'site-2',
      code: 'SITE-SW',
      name: 'SKY WALK',
    };
    expect(formatWorkSiteLabel(regularSite2)).toBe('SITE-SW · SKY WALK');
  });

  it('does not duplicate code if name already starts with code', () => {
    const siteWithCodeInName: WorkSiteOption = {
      id: 'site-3',
      code: 'SITE-AA',
      name: 'SITE-AA อาคาร A',
    };
    expect(formatWorkSiteLabel(siteWithCodeInName)).toBe('SITE-AA อาคาร A');
  });
});
