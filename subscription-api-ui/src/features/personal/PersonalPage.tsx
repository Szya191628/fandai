import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { apiClient, apiKeysApi, authFilesApi } from '@/services/api';
import { useAuthStore, useNotificationStore } from '@/stores';
import { AUTH_FILES_CHANGED_EVENT } from '@/features/authFiles/authFilesEvents';
import { copyToClipboard } from '@/utils/clipboard';
import { getErrorMessage } from '@/utils/helpers';
import type { AuthFileItem } from '@/types';
import { filterAntigravityAccounts, getClientApiBase, maskClientApiKey } from './logic';
import styles from './PersonalPage.module.scss';

type LoadState<T> =
  | { status: 'loading' }
  | { status: 'disconnected' }
  | { status: 'success'; value: T }
  | { status: 'error'; message: string };

const loadingState = <T,>(): LoadState<T> => ({ status: 'loading' });

export function PersonalPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const apiBase = useAuthStore((state) => state.apiBase);
  const managementKey = useAuthStore((state) => state.managementKey);
  const { showNotification } = useNotificationStore();
  const [accounts, setAccounts] = useState<LoadState<AuthFileItem[]>>(loadingState);
  const [clientKeys, setClientKeys] = useState<LoadState<string[]>>(loadingState);
  const [revealedKeys, setRevealedKeys] = useState<Set<number>>(() => new Set());
  const requestIDRef = useRef(0);

  const loadData = useCallback(async () => {
    const requestID = ++requestIDRef.current;
    if (connectionStatus !== 'connected' || !apiBase || !managementKey) {
      setAccounts({ status: 'disconnected' });
      setClientKeys({ status: 'disconnected' });
      setRevealedKeys(new Set());
      return;
    }

    const connectionRevision = apiClient.getConnectionRevision();
    const isCurrent = () =>
      requestID === requestIDRef.current &&
      connectionRevision === apiClient.getConnectionRevision();
    setAccounts(loadingState());
    setClientKeys(loadingState());
    setRevealedKeys(new Set());

    const [filesResult, keysResult] = await Promise.allSettled([
      authFilesApi.list(),
      apiKeysApi.list(),
    ]);
    if (!isCurrent()) return;

    if (filesResult.status === 'fulfilled') {
      setAccounts({ status: 'success', value: filterAntigravityAccounts(filesResult.value.files) });
    } else {
      setAccounts({
        status: 'error',
        message: getErrorMessage(filesResult.reason) || t('personal.load_failed'),
      });
    }

    if (keysResult.status === 'fulfilled') {
      setClientKeys({ status: 'success', value: keysResult.value });
    } else {
      setClientKeys({
        status: 'error',
        message: getErrorMessage(keysResult.reason) || t('personal.load_failed'),
      });
    }
  }, [apiBase, connectionStatus, managementKey, t]);

  useEffect(() => {
    void loadData();
    window.addEventListener(AUTH_FILES_CHANGED_EVENT, loadData);
    return () => {
      requestIDRef.current += 1;
      window.removeEventListener(AUTH_FILES_CHANGED_EVENT, loadData);
    };
  }, [loadData]);

  const handleCopy = useCallback(
    async (value: string, successKey: string, errorKey: string) => {
      const copied = await copyToClipboard(value);
      showNotification(t(copied ? successKey : errorKey), copied ? 'success' : 'error');
    },
    [showNotification, t]
  );

  const toggleKeyVisibility = (index: number) => {
    setRevealedKeys((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const renderCount = <T,>(state: LoadState<T>, getCount: (value: T) => number) => {
    if (state.status === 'success') return getCount(state.value).toLocaleString();
    if (state.status === 'loading') return t('common.loading');
    return '—';
  };

  const clientApiBase = getClientApiBase(apiBase);
  const isConnected = connectionStatus === 'connected';

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.heading}>
          <div className={styles.eyebrow}>Antigravity</div>
          <h1>{t('personal.title')}</h1>
          <p>{t('personal.description')}</p>
        </div>
        <div className={styles.headerActions}>
          <Button
            variant="secondary"
            onClick={() => void loadData()}
            loading={accounts.status === 'loading' || clientKeys.status === 'loading'}
          >
            {t('common.refresh')}
          </Button>
          <Button onClick={() => navigate('/personal/oauth')}>
            {t('personal.add_account')}
          </Button>
        </div>
      </header>

      {!isConnected && (
        <div className={styles.connectionNotice} role="status">
          {t('personal.connection_required')}
        </div>
      )}

      <section className={styles.summaryGrid} aria-label={t('personal.summary')}>
        <Card title={t('personal.accounts')}>
          <div className={styles.metricValue}>{renderCount(accounts, (value) => value.length)}</div>
          {accounts.status === 'success' && accounts.value.length === 0 && (
            <p className={styles.emptyHint}>{t('personal.empty_accounts')}</p>
          )}
          {accounts.status === 'error' && (
            <p className={styles.errorText} role="alert">
              {t('personal.load_error', { message: accounts.message })}
            </p>
          )}
        </Card>

        <Card title={t('personal.client_keys')}>
          <div className={styles.metricValue}>{renderCount(clientKeys, (value) => value.length)}</div>
          {clientKeys.status === 'success' && clientKeys.value.length === 0 && (
            <p className={styles.emptyHint}>{t('personal.empty_keys')}</p>
          )}
          {clientKeys.status === 'error' && (
            <p className={styles.errorText} role="alert">
              {t('personal.load_error', { message: clientKeys.message })}
            </p>
          )}
        </Card>
      </section>

      <Card title={t('personal.api_base_title')}>
        <div className={styles.apiBaseRow}>
          <code className={styles.apiBaseValue}>{clientApiBase || '—'}</code>
          <Button
            variant="secondary"
            size="sm"
            disabled={!clientApiBase || !isConnected}
            onClick={() =>
              void handleCopy(clientApiBase, 'personal.copy_base_success', 'personal.copy_base_error')
            }
          >
            {t('personal.copy_base')}
          </Button>
        </div>
        <p className={styles.cardHint}>{t('personal.api_base_hint')}</p>
      </Card>

      <Card
        title={t('personal.client_keys')}
        extra={
          <Button variant="ghost" size="sm" onClick={() => navigate('/config')}>
            {t('personal.manage_client_keys')}
          </Button>
        }
      >
        {clientKeys.status === 'loading' ? (
          <p className={styles.cardHint}>{t('common.loading')}</p>
        ) : clientKeys.status === 'disconnected' ? (
          <p className={styles.cardHint}>{t('personal.connection_required')}</p>
        ) : clientKeys.status === 'error' ? (
          <p className={styles.errorText} role="alert">
            {t('personal.load_error', { message: clientKeys.message })}
          </p>
        ) : clientKeys.value.length === 0 ? (
          <p className={styles.cardHint}>{t('personal.empty_keys')}</p>
        ) : (
          <div className={styles.keyList}>
            {clientKeys.value.map((key, index) => {
              const revealed = revealedKeys.has(index);
              return (
                <div className={styles.keyRow} key={`${index}-${key.length}`}>
                  <div className={styles.keyDetails}>
                    <span className={styles.keyLabel}>
                      {t('personal.key_label', { index: index + 1 })}
                    </span>
                    <code className={styles.keyValue}>
                      {revealed ? key : maskClientApiKey(key)}
                    </code>
                  </div>
                  <div className={styles.keyActions}>
                    <Button
                      variant="secondary"
                      size="sm"
                      aria-label={t(revealed ? 'personal.hide_key' : 'personal.reveal_key', {
                        index: index + 1,
                      })}
                      onClick={() => toggleKeyVisibility(index)}
                    >
                      {t(revealed ? 'personal.hide_key' : 'personal.reveal_key')}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={!key || !isConnected}
                      aria-label={t('personal.copy_key', { index: index + 1 })}
                      onClick={() =>
                        void handleCopy(
                          key,
                          'personal.copy_key_success',
                          'personal.copy_key_error'
                        )
                      }
                    >
                      {t('common.copy')}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <p className={styles.cardHint}>{t('personal.client_keys_hint')}</p>
      </Card>

      <section className={styles.actionGrid} aria-label={t('personal.account_actions')}>
        <Card title={t('personal.accounts')}>
          <p className={styles.cardHint}>{t('personal.manage_accounts_hint')}</p>
          <Button variant="secondary" onClick={() => navigate('/auth-files')}>
            {t('personal.manage_accounts')}
          </Button>
        </Card>
        <Card title={t('personal.quota_title')}>
          <p className={styles.cardHint}>{t('personal.quota_hint')}</p>
          <Button variant="secondary" onClick={() => navigate('/personal/quota')}>
            {t('personal.view_quota')}
          </Button>
        </Card>
      </section>
    </div>
  );
}
