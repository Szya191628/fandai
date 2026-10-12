import type { AuthFileItem } from '@/types';
import { isAntigravityFile } from '@/utils/quota';

export const filterAntigravityAccounts = (files: AuthFileItem[]): AuthFileItem[] =>
  files.filter(isAntigravityFile);

export const getClientApiBase = (apiBase: string): string => {
  const base = apiBase.trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
  return base ? `${base}/v1` : '';
};

export const maskClientApiKey = (key: string): string => (key ? '••••••••' : '');
