import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import {
  IconEye,
  IconEyeOff,
  IconFileText,
  IconPlus,
  IconRefreshCw,
  IconSearch,
  IconTrash2,
} from '@/components/ui/icons';
import {
  ACCOUNT_POOL_MAX_ACCOUNTS,
  AccountPoolSourceError,
  parseAccountPoolSource,
  type AccountPoolParseIssue,
} from '@/features/accountPool/accountPool';
import { formatTotp, generateTotp, TOTP_PERIOD_SECONDS } from '@/features/accountPool/totp';
import { useAccountPoolStore, useNotificationStore } from '@/stores';
import { copyToClipboard } from '@/utils/clipboard';
import styles from './AccountPoolPage.module.scss';

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const ACCEPTED_FILE_TYPES = '.txt,.csv,.json,.html,text/plain,text/html,application/json';

const maskPassword = (value: string): string => '•'.repeat(Math.min(Math.max(value.length, 8), 16));

const maskSecret = (value: string): string => {
  if (value.length <= 8) return '•'.repeat(value.length);
  return `${value.slice(0, 4)}  ${'•'.repeat(10)}  ${value.slice(-4)}`;
};

const formatIssueLines = (issues: AccountPoolParseIssue[]): string => {
  const shown = issues.slice(0, 8).map((issue) => issue.line);
  return `${shown.join(', ')}${issues.length > shown.length ? ', …' : ''}`;
};

export function AccountPoolPage() {
  const { t } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const showConfirmation = useNotificationStore((state) => state.showConfirmation);
  const accounts = useAccountPoolStore((state) => state.accounts);
  const sourceName = useAccountPoolStore((state) => state.sourceName);
  const loadedAt = useAccountPoolStore((state) => state.loadedAt);
  const replaceAccounts = useAccountPoolStore((state) => state.replaceAccounts);
  const removeAccount = useAccountPoolStore((state) => state.removeAccount);
  const clearAccounts = useAccountPoolStore((state) => state.clearAccounts);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [search, setSearch] = useState('');
  const [sensitiveVisible, setSensitiveVisible] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [pasteModalOpen, setPasteModalOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [importError, setImportError] = useState('');
  const [pageError, setPageError] = useState('');

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);

  const currentCounter = Math.floor(now / 1000 / TOTP_PERIOD_SECONDS);
  const elapsed = (now / 1000) % TOTP_PERIOD_SECONDS;
  const remaining = Math.max(1, Math.ceil(TOTP_PERIOD_SECONDS - elapsed));
  const progressPercent = ((TOTP_PERIOD_SECONDS - elapsed) / TOTP_PERIOD_SECONDS) * 100;
  const progressStyle = {
    '--otp-progress': `${progressPercent}%`,
  } as CSSProperties;

  const totpByAccount = useMemo(() => {
    const result = new Map<string, { code: string; error: boolean }>();
    accounts.forEach((account) => {
      try {
        result.set(account.id, {
          code: generateTotp(account.secret, currentCounter * TOTP_PERIOD_SECONDS * 1000),
          error: false,
        });
      } catch {
        result.set(account.id, { code: t('account_pool.invalid_secret'), error: true });
      }
    });
    return result;
  }, [accounts, currentCounter, t]);

  const visibleAccounts = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return accounts;
    return accounts.filter((account) =>
      `${account.email} ${account.password} ${account.secret}`.toLowerCase().includes(query)
    );
  }, [accounts, search]);

  const describeSourceError = useCallback(
    (error: unknown): string => {
      if (error instanceof AccountPoolSourceError) {
        return t(`account_pool.errors.${error.code}`, { max: ACCOUNT_POOL_MAX_ACCOUNTS });
      }
      return t('account_pool.errors.read_failed');
    },
    [t]
  );

  const importSource = useCallback(
    (source: string, nextSourceName = ''): string | null => {
      try {
        const result = parseAccountPoolSource(source);
        if (result.issues.length > 0) {
          return t('account_pool.errors.invalid_lines', {
            lines: formatIssueLines(result.issues),
          });
        }
        if (result.accounts.length === 0) {
          return t('account_pool.errors.no_accounts');
        }

        replaceAccounts(result.accounts, nextSourceName);
        setSearch('');
        setSensitiveVisible(false);
        setPageError('');
        showNotification(
          result.duplicateCount > 0
            ? t('account_pool.notifications.loaded_with_duplicates', {
                count: result.accounts.length,
                duplicates: result.duplicateCount,
              })
            : t('account_pool.notifications.loaded', { count: result.accounts.length }),
          'success'
        );
        return null;
      } catch (error) {
        return describeSourceError(error);
      }
    },
    [describeSourceError, replaceAccounts, showNotification, t]
  );

  const handleFileChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;

      if (file.size > MAX_SOURCE_BYTES) {
        setPageError(t('account_pool.errors.file_too_large'));
        return;
      }

      try {
        const content = await file.text();
        const error = importSource(content, file.name);
        setPageError(error ?? '');
      } catch {
        setPageError(t('account_pool.errors.read_failed'));
      }
    },
    [importSource, t]
  );

  const handlePasteImport = useCallback(() => {
    if (new TextEncoder().encode(draft).length > MAX_SOURCE_BYTES) {
      setImportError(t('account_pool.errors.file_too_large'));
      return;
    }

    const error = importSource(draft);
    if (error) {
      setImportError(error);
      return;
    }

    setDraft('');
    setImportError('');
    setPasteModalOpen(false);
  }, [draft, importSource, t]);

  const handleCopy = useCallback(
    async (value: string, label: string) => {
      const copied = await copyToClipboard(value);
      showNotification(
        copied
          ? t('account_pool.notifications.copied', { label })
          : t('account_pool.notifications.copy_failed'),
        copied ? 'success' : 'error'
      );
    },
    [showNotification, t]
  );

  const handleClear = useCallback(() => {
    showConfirmation({
      title: t('account_pool.clear_confirm_title'),
      message: t('account_pool.clear_confirm_message', { count: accounts.length }),
      confirmText: t('account_pool.clear_all'),
      variant: 'danger',
      onConfirm: () => {
        clearAccounts();
        setSearch('');
        setSensitiveVisible(false);
        showNotification(t('account_pool.notifications.cleared'), 'success');
      },
    });
  }, [accounts.length, clearAccounts, showConfirmation, showNotification, t]);

  const sourceDescription = loadedAt
    ? t('account_pool.source_summary', {
        source: sourceName || t('account_pool.paste_source'),
        time: new Date(loadedAt).toLocaleTimeString([], { hour12: false }),
      })
    : '';

  return (
    <div className={styles.container}>
      <input
        ref={fileInputRef}
        type="file"
        className={styles.hiddenFileInput}
        accept={ACCEPTED_FILE_TYPES}
        onChange={handleFileChange}
      />

      <header className={styles.hero}>
        <span className={styles.eyebrow}>{t('account_pool.local_badge')}</span>
        <h1 className={styles.pageTitle}>{t('account_pool.title')}</h1>
        <p className={styles.description}>{t('account_pool.description')}</p>
      </header>

      <div className={styles.securityNote} role="note">
        <span className={styles.securityMark} aria-hidden="true" />
        <div>
          <strong>{t('account_pool.security_title')}</strong>
          <span>{t('account_pool.security_note')}</span>
        </div>
      </div>

      <div className={styles.sourceActions}>
        <Button variant="secondary" onClick={() => fileInputRef.current?.click()}>
          <IconFileText size={17} />
          {accounts.length > 0 ? t('account_pool.replace_file') : t('account_pool.load_file')}
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            setImportError('');
            setPasteModalOpen(true);
          }}
        >
          <IconPlus size={17} />
          {t('account_pool.paste_lines')}
        </Button>
        {accounts.length > 0 && (
          <Button variant="danger" onClick={handleClear}>
            <IconTrash2 size={17} />
            {t('account_pool.clear_all')}
          </Button>
        )}
      </div>

      {pageError && <div className={styles.errorBox}>{pageError}</div>}

      {accounts.length === 0 ? (
        <section className={styles.emptyPanel}>
          <div className={styles.emptyIcon} aria-hidden="true">
            <IconFileText size={30} />
          </div>
          <h2>{t('account_pool.empty_title')}</h2>
          <p>{t('account_pool.empty_description')}</p>
          <code>{t('account_pool.format_hint')}</code>
        </section>
      ) : (
        <>
          <section className={styles.toolbar} aria-label={t('account_pool.toolbar_label')}>
            <label className={styles.searchWrap}>
              <span className={styles.visuallyHidden}>{t('account_pool.search_label')}</span>
              <IconSearch size={18} aria-hidden="true" />
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                autoComplete="off"
                placeholder={t('account_pool.search_placeholder')}
              />
            </label>
            <div className={styles.toolbarActions}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setSensitiveVisible((visible) => !visible)}
                aria-pressed={sensitiveVisible}
              >
                {sensitiveVisible ? <IconEyeOff size={16} /> : <IconEye size={16} />}
                {sensitiveVisible
                  ? t('account_pool.hide_sensitive')
                  : t('account_pool.show_sensitive')}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setNow(Date.now());
                  showNotification(t('account_pool.notifications.refreshed'), 'success');
                }}
              >
                <IconRefreshCw size={16} />
                {t('account_pool.refresh_codes')}
              </Button>
            </div>
          </section>

          <div className={styles.summary}>
            <span>
              {t('account_pool.total_summary', {
                total: accounts.length,
                visible: visibleAccounts.length,
              })}
            </span>
            <span>
              {t('account_pool.clock_summary', {
                time: new Date(now).toLocaleTimeString([], { hour12: false }),
                seconds: remaining,
              })}
            </span>
          </div>
          {sourceDescription && <div className={styles.sourceSummary}>{sourceDescription}</div>}

          {visibleAccounts.length === 0 ? (
            <div className={styles.noMatches}>{t('account_pool.no_matches')}</div>
          ) : (
            <section className={styles.grid} aria-label={t('account_pool.list_label')}>
              {visibleAccounts.map((account) => {
                const originalIndex = accounts.findIndex((item) => item.id === account.id);
                const totp = totpByAccount.get(account.id);
                const fullLine = `${account.email}|${account.password}|${account.secret}`;

                return (
                  <article className={styles.accountCard} key={account.id}>
                    <div className={styles.cardHead}>
                      <div>
                        <span className={styles.accountIndex}>
                          {t('account_pool.account_number', {
                            index: String(originalIndex + 1).padStart(2, '0'),
                          })}
                        </span>
                        <span className={styles.pendingBadge}>
                          {t('account_pool.pending_badge')}
                        </span>
                      </div>
                      <div className={styles.cardActions}>
                        <button
                          type="button"
                          className={styles.textButton}
                          onClick={() => void handleCopy(fullLine, t('account_pool.full_line'))}
                        >
                          {t('account_pool.copy_line')}
                        </button>
                        <button
                          type="button"
                          className={styles.removeButton}
                          title={t('account_pool.remove_account')}
                          aria-label={t('account_pool.remove_account')}
                          onClick={() => removeAccount(account.id)}
                        >
                          <IconTrash2 size={15} />
                        </button>
                      </div>
                    </div>

                    <div className={styles.fields}>
                      <button
                        type="button"
                        className={styles.copyField}
                        onClick={() => void handleCopy(account.email, t('account_pool.email'))}
                      >
                        <span className={styles.fieldLabel}>{t('account_pool.email')}</span>
                        <span className={`${styles.fieldValue} ${styles.emailValue}`}>
                          {account.email}
                        </span>
                        <span className={styles.copyHint}>{t('account_pool.copy')}</span>
                      </button>
                      <button
                        type="button"
                        className={styles.copyField}
                        onClick={() =>
                          void handleCopy(account.password, t('account_pool.password'))
                        }
                      >
                        <span className={styles.fieldLabel}>{t('account_pool.password')}</span>
                        <span className={`${styles.fieldValue} ${styles.passwordValue}`}>
                          {sensitiveVisible ? account.password : maskPassword(account.password)}
                        </span>
                        <span className={styles.copyHint}>{t('account_pool.copy')}</span>
                      </button>
                      <button
                        type="button"
                        className={styles.copyField}
                        onClick={() => void handleCopy(account.secret, t('account_pool.secret'))}
                      >
                        <span className={styles.fieldLabel}>{t('account_pool.secret')}</span>
                        <span className={`${styles.fieldValue} ${styles.secretValue}`}>
                          {sensitiveVisible ? account.secret : maskSecret(account.secret)}
                        </span>
                        <span className={styles.copyHint}>{t('account_pool.copy')}</span>
                      </button>
                    </div>

                    <button
                      type="button"
                      className={styles.otpPanel}
                      style={progressStyle}
                      disabled={!totp || totp.error}
                      onClick={() => {
                        if (totp && !totp.error) {
                          void handleCopy(totp.code, t('account_pool.otp'));
                        }
                      }}
                    >
                      <span>
                        <span className={styles.otpLabel}>{t('account_pool.otp_label')}</span>
                        <span className={`${styles.otpCode} ${totp?.error ? styles.otpError : ''}`}>
                          {totp?.error ? totp.code : formatTotp(totp?.code ?? '------')}
                        </span>
                      </span>
                      <span className={styles.countdown}>
                        <span>{t('account_pool.seconds_short', { seconds: remaining })}</span>
                      </span>
                      <span className={styles.otpProgress} aria-hidden="true" />
                    </button>
                  </article>
                );
              })}
            </section>
          )}

          <footer className={styles.footer}>{t('account_pool.footer')}</footer>
        </>
      )}

      <Modal
        open={pasteModalOpen}
        title={t('account_pool.paste_modal_title')}
        onClose={() => {
          setPasteModalOpen(false);
          setImportError('');
        }}
        width={680}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setPasteModalOpen(false);
                setImportError('');
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button onClick={handlePasteImport}>{t('account_pool.load_accounts')}</Button>
          </>
        }
      >
        <div className={styles.pasteForm}>
          <p>{t('account_pool.paste_modal_description')}</p>
          <label htmlFor="account-pool-input">{t('account_pool.paste_input_label')}</label>
          <textarea
            id="account-pool-input"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setImportError('');
            }}
            rows={12}
            autoComplete="off"
            spellCheck={false}
            placeholder={t('account_pool.paste_placeholder')}
          />
          <span className={styles.pasteHint}>{t('account_pool.format_hint')}</span>
          {importError && <div className={styles.errorBox}>{importError}</div>}
        </div>
      </Modal>
    </div>
  );
}
