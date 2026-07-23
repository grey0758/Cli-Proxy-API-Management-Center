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
  IconPhone,
  IconPlus,
  IconRefreshCw,
  IconSearch,
  IconTrash2,
} from '@/components/ui/icons';
import {
  ACCOUNT_POOL_MAX_ACCOUNTS,
  AccountPoolSnapshotError,
  AccountPoolSourceError,
  parseAccountPoolSources,
  type AccountPoolStatus,
  type AccountPoolNamedParseIssue,
  type AccountPoolNamedSource,
} from '@/features/accountPool/accountPool';
import { formatTotp, generateTotp, TOTP_PERIOD_SECONDS } from '@/features/accountPool/totp';
import {
  findPhoneBinding,
  PhonePoolPayloadError,
  type PhonePoolSmsResponse,
  type PhonePoolSnapshot,
} from '@/features/phonePool/phonePool';
import { accountPoolApi } from '@/services/api/accountPool';
import { phonePoolApi } from '@/services/api/phonePool';
import { useAccountPoolStore, useNotificationStore } from '@/stores';
import { copyToClipboard } from '@/utils/clipboard';
import styles from './AccountPoolPage.module.scss';

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const ACCEPTED_FILE_TYPES = '.txt,.csv,.json,.html,text/plain,text/html,application/json';
type AccountPoolFilter = 'all' | AccountPoolStatus;

const maskPassword = (value: string): string => '•'.repeat(Math.min(Math.max(value.length, 8), 16));

const maskSecret = (value: string): string => {
  if (value.length <= 8) return '•'.repeat(value.length);
  return `${value.slice(0, 4)}  ${'•'.repeat(10)}  ${value.slice(-4)}`;
};

const formatIssueLines = (issues: AccountPoolNamedParseIssue[]): string => {
  const shown = issues
    .slice(0, 8)
    .map((issue) => (issue.sourceName ? `${issue.sourceName}:${issue.line}` : String(issue.line)));
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
  const [statusFilter, setStatusFilter] = useState<AccountPoolFilter>('all');
  const [sensitiveVisible, setSensitiveVisible] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [pasteModalOpen, setPasteModalOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [importError, setImportError] = useState('');
  const [pageError, setPageError] = useState('');
  const [serverLoading, setServerLoading] = useState(true);
  const [phoneSnapshot, setPhoneSnapshot] = useState<PhonePoolSnapshot | null>(null);
  const [phonePoolError, setPhonePoolError] = useState('');
  const [phonePoolLoading, setPhonePoolLoading] = useState(true);
  const [bindingAccountEmail, setBindingAccountEmail] = useState('');
  const [bindingSearch, setBindingSearch] = useState('');
  const [selectedPhoneId, setSelectedPhoneId] = useState('');
  const [phoneActionBusy, setPhoneActionBusy] = useState('');
  const [smsResponses, setSmsResponses] = useState<Record<string, PhonePoolSmsResponse>>({});

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

  const statusCounts = useMemo(
    () => ({
      all: accounts.length,
      pending: accounts.filter((account) => account.status === 'pending').length,
      imported: accounts.filter((account) => account.status === 'imported').length,
    }),
    [accounts]
  );

  const visibleAccounts = useMemo(() => {
    const query = search.trim().toLowerCase();
    return accounts.filter((account) => {
      if (statusFilter !== 'all' && account.status !== statusFilter) return false;
      if (!query) return true;
      return `${account.email} ${account.password} ${account.secret}`.toLowerCase().includes(query);
    });
  }, [accounts, search, statusFilter]);

  const describeSourceError = useCallback(
    (error: unknown): string => {
      if (error instanceof AccountPoolSourceError) {
        return t(`account_pool.errors.${error.code}`, { max: ACCOUNT_POOL_MAX_ACCOUNTS });
      }
      return t('account_pool.errors.read_failed');
    },
    [t]
  );

  const importSources = useCallback(
    (sources: AccountPoolNamedSource[], nextSourceName = ''): string | null => {
      try {
        const result = parseAccountPoolSources(sources);
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
        setStatusFilter('all');
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

  const loadServerSnapshot = useCallback(
    async (notify = false) => {
      setServerLoading(true);
      setPageError('');
      try {
        const snapshot = await accountPoolApi.getServerSnapshot();
        replaceAccounts(snapshot.accounts, t('account_pool.server_source'));
        setSearch('');
        setStatusFilter('all');
        setSensitiveVisible(false);
        if (notify) {
          showNotification(
            t('account_pool.notifications.server_loaded', {
              count: snapshot.accounts.length,
            }),
            'success'
          );
        }
      } catch (error) {
        setPageError(
          error instanceof AccountPoolSnapshotError
            ? t('account_pool.errors.server_invalid')
            : t('account_pool.errors.server_unavailable')
        );
      } finally {
        setServerLoading(false);
      }
    },
    [replaceAccounts, showNotification, t]
  );

  useEffect(() => {
    void loadServerSnapshot(false);
  }, [loadServerSnapshot]);

  const loadPhoneSnapshot = useCallback(async () => {
    setPhonePoolLoading(true);
    setPhonePoolError('');
    try {
      setPhoneSnapshot(await phonePoolApi.getSnapshot());
    } catch (error) {
      setPhonePoolError(
        error instanceof PhonePoolPayloadError
          ? t('account_pool.phone_errors.invalid_payload')
          : t('account_pool.phone_errors.load_failed')
      );
    } finally {
      setPhonePoolLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadPhoneSnapshot();
  }, [loadPhoneSnapshot]);

  const phoneById = useMemo(
    () => new Map((phoneSnapshot?.phones ?? []).map((phone) => [phone.id, phone])),
    [phoneSnapshot]
  );

  const selectablePhones = useMemo(() => {
    const query = bindingSearch.trim().toLocaleLowerCase();
    return (phoneSnapshot?.phones ?? []).filter(
      (phone) => phone.enabled && (!query || phone.number.toLocaleLowerCase().includes(query))
    );
  }, [bindingSearch, phoneSnapshot]);

  const openBindingModal = useCallback(
    (accountEmail: string) => {
      const binding = findPhoneBinding(phoneSnapshot, accountEmail);
      const currentPhone = binding ? phoneById.get(binding.phoneId) : undefined;
      setBindingAccountEmail(accountEmail);
      setSelectedPhoneId(currentPhone?.enabled ? currentPhone.id : '');
      setBindingSearch('');
    },
    [phoneById, phoneSnapshot]
  );

  const closeBindingModal = useCallback(() => {
    if (phoneActionBusy) return;
    setBindingAccountEmail('');
    setSelectedPhoneId('');
    setBindingSearch('');
  }, [phoneActionBusy]);

  const handleBindPhone = useCallback(async () => {
    if (!bindingAccountEmail || !selectedPhoneId) return;
    setPhoneActionBusy(bindingAccountEmail);
    try {
      setPhoneSnapshot(await phonePoolApi.bind(bindingAccountEmail, selectedPhoneId));
      showNotification(t('account_pool.phone_notifications.bound'), 'success');
      setBindingAccountEmail('');
      setSelectedPhoneId('');
      setBindingSearch('');
    } catch {
      showNotification(t('account_pool.phone_errors.bind_failed'), 'error');
    } finally {
      setPhoneActionBusy('');
    }
  }, [bindingAccountEmail, selectedPhoneId, showNotification, t]);

  const handleUnbindPhone = useCallback(
    (accountEmail: string) => {
      showConfirmation({
        title: t('account_pool.phone_unbind_confirm_title'),
        message: t('account_pool.phone_unbind_confirm_message'),
        confirmText: t('account_pool.phone_unbind'),
        variant: 'danger',
        onConfirm: () => {
          setPhoneActionBusy(accountEmail);
          void phonePoolApi
            .unbind(accountEmail)
            .then((next) => {
              setPhoneSnapshot(next);
              setSmsResponses((current) => {
                const updated = { ...current };
                delete updated[accountEmail.toLocaleLowerCase()];
                return updated;
              });
              showNotification(t('account_pool.phone_notifications.unbound'), 'success');
            })
            .catch(() => {
              showNotification(t('account_pool.phone_errors.unbind_failed'), 'error');
            })
            .finally(() => setPhoneActionBusy(''));
        },
      });
    },
    [showConfirmation, showNotification, t]
  );

  const handleRequestSms = useCallback(
    async (accountEmail: string) => {
      setPhoneActionBusy(accountEmail);
      try {
        const response = await phonePoolApi.requestCode({ accountEmail });
        setSmsResponses((current) => ({
          ...current,
          [accountEmail.toLocaleLowerCase()]: response,
        }));
        showNotification(t('account_pool.phone_notifications.response_received'), 'success');
      } catch {
        showNotification(t('account_pool.phone_errors.request_failed'), 'error');
      } finally {
        setPhoneActionBusy('');
      }
    },
    [showNotification, t]
  );

  const handleFileChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      event.target.value = '';
      if (files.length === 0) return;

      const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
      if (files.some((file) => file.size > MAX_SOURCE_BYTES) || totalBytes > MAX_SOURCE_BYTES) {
        setPageError(t('account_pool.errors.file_too_large'));
        return;
      }

      try {
        const contents = await Promise.all(files.map((file) => file.text()));
        const sources = files.map((file, index) => ({
          name: file.name,
          source: contents[index],
        }));
        const sourceLabel = files.map((file) => file.name).join(', ');
        const error = importSources(sources, sourceLabel);
        setPageError(error ?? '');
      } catch {
        setPageError(t('account_pool.errors.read_failed'));
      }
    },
    [importSources, t]
  );

  const handlePasteImport = useCallback(() => {
    if (new TextEncoder().encode(draft).length > MAX_SOURCE_BYTES) {
      setImportError(t('account_pool.errors.file_too_large'));
      return;
    }

    const error = importSources([{ name: '', source: draft }]);
    if (error) {
      setImportError(error);
      return;
    }

    setDraft('');
    setImportError('');
    setPasteModalOpen(false);
  }, [draft, importSources, t]);

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
        setStatusFilter('all');
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
        multiple
        onChange={handleFileChange}
      />

      <header className={styles.hero}>
        <span className={styles.eyebrow}>{t('account_pool.server_badge')}</span>
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
        <Button
          variant="secondary"
          disabled={serverLoading}
          onClick={() => void loadServerSnapshot(true)}
        >
          <IconRefreshCw size={17} className={serverLoading ? styles.spinningIcon : undefined} />
          {serverLoading ? t('account_pool.loading_server') : t('account_pool.reload_server')}
        </Button>
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
      {phonePoolError && (
        <div className={styles.phoneWarning}>
          <span>{phonePoolError}</span>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void loadPhoneSnapshot()}
            disabled={phonePoolLoading}
          >
            {t('account_pool.phone_retry')}
          </Button>
        </div>
      )}

      {serverLoading && accounts.length === 0 ? (
        <section className={styles.emptyPanel} aria-live="polite">
          <div className={`${styles.emptyIcon} ${styles.spinningIcon}`} aria-hidden="true">
            <IconRefreshCw size={30} />
          </div>
          <h2>{t('account_pool.loading_server_title')}</h2>
          <p>{t('account_pool.loading_server_description')}</p>
        </section>
      ) : accounts.length === 0 ? (
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
            <div
              className={styles.statusFilters}
              role="group"
              aria-label={t('account_pool.status_filter_label')}
            >
              {(['all', 'pending', 'imported'] as const).map((filter) => (
                <button
                  key={filter}
                  type="button"
                  className={`${styles.statusFilter} ${
                    statusFilter === filter ? styles.statusFilterActive : ''
                  }`}
                  aria-pressed={statusFilter === filter}
                  onClick={() => setStatusFilter(filter)}
                >
                  <span>{t(`account_pool.filter_${filter}`)}</span>
                  <span className={styles.filterCount}>{statusCounts[filter]}</span>
                </button>
              ))}
            </div>
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
                const phoneBinding = findPhoneBinding(phoneSnapshot, account.email);
                const boundPhone = phoneBinding ? phoneById.get(phoneBinding.phoneId) : undefined;
                const smsResponse = smsResponses[account.email.toLocaleLowerCase()];
                const phoneBusy = phoneActionBusy === account.email;
                const phoneActionsBlocked = Boolean(phoneActionBusy);

                return (
                  <article className={styles.accountCard} key={account.id}>
                    <div className={styles.cardHead}>
                      <div>
                        <span className={styles.accountIndex}>
                          {t('account_pool.account_number', {
                            index: String(originalIndex + 1).padStart(2, '0'),
                          })}
                        </span>
                        <span
                          className={`${styles.statusBadge} ${
                            account.status === 'imported'
                              ? styles.importedBadge
                              : styles.pendingBadge
                          }`}
                        >
                          {account.status === 'imported'
                            ? t('account_pool.imported_badge')
                            : t('account_pool.pending_badge')}
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

                    <div className={styles.phoneBindingPanel}>
                      <div className={styles.phoneBindingHead}>
                        <span className={styles.phoneBindingIcon}>
                          <IconPhone size={17} />
                        </span>
                        <div>
                          <span>{t('account_pool.phone_binding_title')}</span>
                          <strong>
                            {boundPhone
                              ? boundPhone.number
                              : phonePoolLoading
                                ? t('account_pool.phone_loading')
                                : t('account_pool.phone_unbound')}
                          </strong>
                        </div>
                        {boundPhone && (
                          <span className={styles.phoneCountBadge}>
                            {t('account_pool.phone_binding_count', {
                              count: boundPhone.bindingCount,
                            })}
                          </span>
                        )}
                      </div>
                      <div className={styles.phoneBindingActions}>
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={
                            phonePoolLoading || Boolean(phonePoolError) || phoneActionsBlocked
                          }
                          onClick={() => openBindingModal(account.email)}
                        >
                          {boundPhone
                            ? t('account_pool.phone_rebind')
                            : t('account_pool.phone_select')}
                        </Button>
                        <Button
                          size="sm"
                          loading={phoneBusy}
                          disabled={!boundPhone || !boundPhone.enabled || phoneActionsBlocked}
                          onClick={() => void handleRequestSms(account.email)}
                        >
                          {t('account_pool.phone_request_code')}
                        </Button>
                        {boundPhone && (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={phoneActionsBlocked}
                            onClick={() => handleUnbindPhone(account.email)}
                          >
                            {t('account_pool.phone_unbind')}
                          </Button>
                        )}
                      </div>
                      {boundPhone && !boundPhone.enabled && (
                        <small className={styles.phoneDisabledHint}>
                          {t('account_pool.phone_disabled_hint')}
                        </small>
                      )}
                      {smsResponse && (
                        <div className={styles.smsResponse} aria-live="polite">
                          <div>
                            <strong>{t('account_pool.phone_response_title')}</strong>
                            <span>
                              HTTP {smsResponse.providerStatus}
                              {smsResponse.truncated
                                ? ` · ${t('account_pool.phone_response_truncated')}`
                                : ''}
                            </span>
                          </div>
                          <pre>{smsResponse.body || t('account_pool.phone_response_empty')}</pre>
                          <small>{new Date(smsResponse.fetchedAt).toLocaleString()}</small>
                        </div>
                      )}
                    </div>
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

      <Modal
        open={Boolean(bindingAccountEmail)}
        title={t('account_pool.phone_modal_title')}
        onClose={closeBindingModal}
        closeDisabled={Boolean(phoneActionBusy)}
        width={620}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={closeBindingModal}
              disabled={Boolean(phoneActionBusy)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              onClick={() => void handleBindPhone()}
              disabled={!selectedPhoneId}
              loading={Boolean(phoneActionBusy)}
            >
              {t('account_pool.phone_bind_submit')}
            </Button>
          </>
        }
      >
        <div className={styles.phoneModal}>
          <p>
            {t('account_pool.phone_modal_description', {
              email: bindingAccountEmail,
            })}
          </p>
          <label className={styles.phoneSearch}>
            <span className={styles.visuallyHidden}>{t('account_pool.phone_search_label')}</span>
            <IconSearch size={17} />
            <input
              type="search"
              value={bindingSearch}
              onChange={(event) => setBindingSearch(event.target.value)}
              placeholder={t('account_pool.phone_search_placeholder')}
              autoComplete="off"
            />
          </label>
          {selectablePhones.length === 0 ? (
            <div className={styles.phoneModalEmpty}>
              {phoneSnapshot?.enabledCount
                ? t('account_pool.phone_no_matches')
                : t('account_pool.phone_none_available')}
            </div>
          ) : (
            <div className={styles.phoneChoices} role="radiogroup">
              {selectablePhones.map((phone) => (
                <button
                  key={phone.id}
                  type="button"
                  className={selectedPhoneId === phone.id ? styles.phoneChoiceSelected : ''}
                  role="radio"
                  aria-checked={selectedPhoneId === phone.id}
                  onClick={() => setSelectedPhoneId(phone.id)}
                >
                  <span>
                    <strong>{phone.number}</strong>
                    <small>
                      {t('account_pool.phone_choice_summary', {
                        count: phone.bindingCount,
                        current: phone.currentBindings,
                      })}
                    </small>
                  </span>
                  <span className={styles.radioMark} aria-hidden="true" />
                </button>
              ))}
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}
