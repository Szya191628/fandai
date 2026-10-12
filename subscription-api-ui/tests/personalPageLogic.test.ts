import { describe, expect, test } from 'bun:test';
import type { AuthFileItem } from '@/types';
import {
  filterAntigravityAccounts,
  getClientApiBase,
  maskClientApiKey,
} from '@/features/personal/logic';
import en from '@/i18n/locales/en.json';
import zhCN from '@/i18n/locales/zh-CN.json';
import zhTW from '@/i18n/locales/zh-TW.json';
import ru from '@/i18n/locales/ru.json';

const file = (name: string, provider: string, extra: Partial<AuthFileItem> = {}): AuthFileItem =>
  ({ name, provider, ...extra }) as AuthFileItem;

describe('personal Antigravity pool helpers', () => {
  test('filters account credentials to Antigravity while retaining disabled account entries', () => {
    const files = [
      file('ag.json', 'antigravity'),
      file('ag-disabled.json', 'antigravity', { disabled: true }),
      file('claude.json', 'claude'),
    ];

    expect(filterAntigravityAccounts(files).map((entry) => entry.name)).toEqual([
      'ag.json',
      'ag-disabled.json',
    ]);
  });

  test('builds the client API base from the current connection and leaves empty bases unknown', () => {
    expect(getClientApiBase('https://proxy.example/gateway/')).toBe(
      'https://proxy.example/gateway/v1'
    );
    expect(getClientApiBase('https://proxy.example/gateway/v1')).toBe(
      'https://proxy.example/gateway/v1'
    );
    expect(getClientApiBase('')).toBe('');
  });

  test('uses a fixed mask that does not disclose key content or length', () => {
    expect(maskClientApiKey('client-secret-123')).toBe('••••••••');
    expect(maskClientApiKey('x')).toBe('••••••••');
    expect(maskClientApiKey('')).toBe('');
  });

  test('provides every personal page translation in all supported locales', () => {
    const keys = Object.keys(en.personal);
    for (const locale of [zhCN, zhTW, ru]) {
      for (const key of keys) {
        expect((locale.personal as Record<string, string>)[key]?.trim()).toBeTruthy();
      }
    }
  });
});
