import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider, LanguageSwitcher, localizeErrorMessage, messages, uiDateTimeFormat, translateUi, useLanguage } from '../src/i18n';
import { legacyUiTranslations } from '../src/legacyUiTranslations';

function mount(children: ReactNode) {
  const container = document.createElement('div');
  container.id = 'root';
  document.body.append(container);
  return render(<LanguageProvider>{children}</LanguageProvider>, { container });
}

afterEach(() => {
  cleanup();
  document.getElementById('root')?.remove();
  vi.restoreAllMocks();
});

function Sample() {
  const { language, t } = useLanguage();
  return <><LanguageSwitcher /><span>{t('signIn')}</span><button>{translateUi('ยกเลิก')}</button><input placeholder={translateUi('ค้นหาร้าน')} /><span data-testid="date">{uiDateTimeFormat({ dateStyle: 'medium', timeZone: 'Asia/Bangkok' }).format(new Date('2026-10-10T12:00:00+07:00'))}</span><span data-testid="language">{language}</span></>;
}

describe('screen language', () => {
  it('has Thai and Myanmar copy for every catalog entry', () => {
    for (const entry of Object.values(messages)) {
      expect(entry.th.trim()).not.toBe('');
      expect(entry.my.trim()).not.toBe('');
    }
    for (const [thai, myanmar] of Object.entries(legacyUiTranslations)) {
      expect(thai.trim()).not.toBe('');
      expect(myanmar).toMatch(/[က-႟]/);
      expect([...myanmar.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort())
        .toEqual([...thai.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort());
    }
  });

  it('starts in Thai, switches without remounting, and restores Thai', async () => {
    mount(<Sample />);
    expect(screen.getByText('เข้าสู่ระบบ')).toBeTruthy();
    expect(screen.getByTestId('date').textContent).toContain('2569');
    const search = screen.getByPlaceholderText('ค้นหาร้าน') as HTMLInputElement;
    fireEvent.change(search, { target: { value: 'ร้านเดิม' } });
    const select = screen.getByLabelText('ภาษา');
    fireEvent.change(select, { target: { value: 'my' } });
    await waitFor(() => expect(screen.getByText('ပယ်ဖျက်ရန်')).toBeTruthy());
    expect(screen.getByText('အကောင့်ဝင်ရန်')).toBeTruthy();
    expect(screen.getByPlaceholderText('ဆိုင်ရှာရန်')).toBeTruthy();
    expect(search.value).toBe('ร้านเดิม');
    expect(screen.getByTestId('date').textContent).toContain('2026');
    expect(screen.getByTestId('date').textContent).toContain('10');
    expect(document.documentElement.lang).toBe('my');
    expect(document.title).toContain('ရေခဲ');
    expect(window.localStorage.getItem('ice-delivery.language.v1')).toBe('my');
    fireEvent.change(select, { target: { value: 'th' } });
    await waitFor(() => expect(screen.getByText('ยกเลิก')).toBeTruthy());
    expect(screen.getByTestId('date').textContent).toContain('2569');
    expect(search.value).toBe('ร้านเดิม');
  });

  it('loads the saved language after remount', () => {
    window.localStorage.setItem('ice-delivery.language.v1', 'my');
    mount(<Sample />);
    expect(screen.getByTestId('language').textContent).toBe('my');
    expect(screen.getByText('အကောင့်ဝင်ရန်')).toBeTruthy();
    expect(screen.getByTestId('date').textContent).toContain('2026');
  });

  it('keeps the selected language in memory when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage unavailable'); });
    mount(<Sample />);
    fireEvent.change(screen.getByLabelText('ภาษา'), { target: { value: 'my' } });
    expect(screen.getByTestId('language').textContent).toBe('my');
    expect(localizeErrorMessage('Invalid login credentials')).toContain('စကားဝှက်');
    expect(localizeErrorMessage('unrecognized backend failure')).toContain('အမှား');
  });

  it('falls back to Thai when storage cannot be read', () => {
    window.localStorage.setItem('ice-delivery.language.v1', 'my');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage unavailable'); });
    mount(<Sample />);
    expect(screen.getByTestId('language').textContent).toBe('th');
  });
});
