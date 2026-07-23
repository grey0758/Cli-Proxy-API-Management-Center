import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import {
  IconCheckCircle2,
  IconPhone,
  IconPlus,
  IconRefreshCw,
  IconSearch,
} from '@/components/ui/icons';
import {
  PHONE_POOL_MAX_IMPORT_BYTES,
  PhonePoolPayloadError,
  type PhonePoolSmsResponse,
  type PhonePoolSnapshot,
} from '@/features/phonePool/phonePool';
import { phonePoolApi } from '@/services/api/phonePool';
import { useNotificationStore } from '@/stores';
import styles from './PhonePoolPage.module.scss';

type PhoneFilter = 'all' | 'enabled' | 'disabled';

export function PhonePoolPage() {
  const { t } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const [snapshot, setSnapshot] = useState<PhonePoolSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<PhoneFilter>('enabled');
  const [importOpen, setImportOpen] = useState(false);
  const [importSource, setImportSource] = useState('');
  const [baselineBindings, setBaselineBindings] = useState(0);
  const [importError, setImportError] = useState('');
  const [importing, setImporting] = useState(false);
  const [busyPhoneId, setBusyPhoneId] = useState('');
  const [responses, setResponses] = useState<Record<string, PhonePoolSmsResponse>>({});

  const loadSnapshot = useCallback(
    async (notify = false) => {
      setLoading(true);
      setPageError('');
      try {
        const next = await phonePoolApi.getSnapshot();
        setSnapshot(next);
        if (notify) {
          showNotification(t('phone_pool.notifications.reloaded'), 'success');
        }
      } catch (error) {
        setPageError(
          error instanceof PhonePoolPayloadError
            ? t('phone_pool.errors.invalid_payload')
            : t('phone_pool.errors.load_failed')
        );
      } finally {
        setLoading(false);
      }
    },
    [showNotification, t]
  );

  useEffect(() => {
    void loadSnapshot(false);
  }, [loadSnapshot]);

  const filterCounts = useMemo(
    () => ({
      all: snapshot?.phones.length ?? 0,
      enabled: snapshot?.phones.filter((phone) => phone.enabled).length ?? 0,
      disabled: snapshot?.phones.filter((phone) => !phone.enabled).length ?? 0,
    }),
    [snapshot]
  );

  const visiblePhones = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return (snapshot?.phones ?? []).filter((phone) => {
      if (filter === 'enabled' && !phone.enabled) return false;
      if (filter === 'disabled' && phone.enabled) return false;
      return !query || phone.number.toLocaleLowerCase().includes(query);
    });
  }, [filter, search, snapshot]);

  const totalBindingCount = useMemo(
    () => snapshot?.phones.reduce((total, phone) => total + phone.bindingCount, 0) ?? 0,
    [snapshot]
  );
  const currentBindingCount = snapshot?.bindings.length ?? 0;

  const closeImport = useCallback(() => {
    if (importing) return;
    setImportOpen(false);
    setImportSource('');
    setImportError('');
    setBaselineBindings(0);
  }, [importing]);

  const handleImport = useCallback(async () => {
    const bytes = new TextEncoder().encode(importSource).length;
    if (!importSource.trim()) {
      setImportError(t('phone_pool.errors.empty_import'));
      return;
    }
    if (bytes > PHONE_POOL_MAX_IMPORT_BYTES) {
      setImportError(t('phone_pool.errors.import_too_large'));
      return;
    }
    if (!Number.isInteger(baselineBindings) || baselineBindings < 0) {
      setImportError(t('phone_pool.errors.invalid_baseline'));
      return;
    }

    setImporting(true);
    setImportError('');
    try {
      const next = await phonePoolApi.importPhones(importSource, baselineBindings);
      setSnapshot(next);
      const importedCount = importSource
        .split(/\r?\n/)
        .filter((line) => line.trim() && !line.trim().startsWith('#')).length;
      setImportOpen(false);
      setImportSource('');
      setBaselineBindings(0);
      showNotification(t('phone_pool.notifications.imported', { count: importedCount }), 'success');
    } catch {
      setImportError(t('phone_pool.errors.import_failed'));
    } finally {
      setImporting(false);
    }
  }, [baselineBindings, importSource, showNotification, t]);

  const handleToggleEnabled = useCallback(
    async (phoneId: string, enabled: boolean) => {
      setBusyPhoneId(phoneId);
      try {
        setSnapshot(await phonePoolApi.setEnabled(phoneId, enabled));
        showNotification(
          enabled ? t('phone_pool.notifications.enabled') : t('phone_pool.notifications.disabled'),
          'success'
        );
      } catch {
        showNotification(t('phone_pool.errors.update_failed'), 'error');
      } finally {
        setBusyPhoneId('');
      }
    },
    [showNotification, t]
  );

  const handleRequestCode = useCallback(
    async (phoneId: string) => {
      setBusyPhoneId(phoneId);
      try {
        const response = await phonePoolApi.requestCode({ phoneId });
        setResponses((current) => ({ ...current, [phoneId]: response }));
        showNotification(t('phone_pool.notifications.response_received'), 'success');
      } catch {
        showNotification(t('phone_pool.errors.request_failed'), 'error');
      } finally {
        setBusyPhoneId('');
      }
    },
    [showNotification, t]
  );

  return (
    <div className={styles.container}>
      <header className={styles.hero}>
        <span className={styles.eyebrow}>{t('phone_pool.badge')}</span>
        <h1>{t('phone_pool.title')}</h1>
        <p>{t('phone_pool.description')}</p>
      </header>

      <div className={styles.securityNote} role="note">
        <IconCheckCircle2 size={19} aria-hidden="true" />
        <div>
          <strong>{t('phone_pool.security_title')}</strong>
          <span>{t('phone_pool.security_note')}</span>
        </div>
      </div>

      <div className={styles.actions}>
        <Button variant="secondary" onClick={() => void loadSnapshot(true)} disabled={loading}>
          <IconRefreshCw size={17} className={loading ? styles.spinningIcon : undefined} />
          {t('phone_pool.reload')}
        </Button>
        <Button
          onClick={() => {
            setImportError('');
            setImportOpen(true);
          }}
        >
          <IconPlus size={17} />
          {t('phone_pool.import')}
        </Button>
      </div>

      {pageError && <div className={styles.errorBox}>{pageError}</div>}

      <section className={styles.metrics} aria-label={t('phone_pool.metrics_label')}>
        <article>
          <span>{t('phone_pool.total_phones')}</span>
          <strong>{snapshot?.count ?? 0}</strong>
        </article>
        <article>
          <span>{t('phone_pool.available_phones')}</span>
          <strong>{snapshot?.enabledCount ?? 0}</strong>
        </article>
        <article>
          <span>{t('phone_pool.total_binding_count')}</span>
          <strong>{totalBindingCount}</strong>
        </article>
        <article>
          <span>{t('phone_pool.current_bindings')}</span>
          <strong>{currentBindingCount}</strong>
        </article>
      </section>

      <section className={styles.toolbar} aria-label={t('phone_pool.toolbar_label')}>
        <div className={styles.filters} role="group" aria-label={t('phone_pool.filter_label')}>
          {(['all', 'enabled', 'disabled'] as const).map((item) => (
            <button
              key={item}
              type="button"
              className={filter === item ? styles.activeFilter : undefined}
              aria-pressed={filter === item}
              onClick={() => setFilter(item)}
            >
              <span>{t(`phone_pool.filter_${item}`)}</span>
              <span>{filterCounts[item]}</span>
            </button>
          ))}
        </div>
        <label className={styles.search}>
          <span className={styles.visuallyHidden}>{t('phone_pool.search_label')}</span>
          <IconSearch size={18} />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('phone_pool.search_placeholder')}
            autoComplete="off"
          />
        </label>
      </section>

      {loading && !snapshot ? (
        <section className={styles.emptyPanel} aria-live="polite">
          <IconRefreshCw size={30} className={styles.spinningIcon} />
          <h2>{t('phone_pool.loading')}</h2>
        </section>
      ) : visiblePhones.length === 0 ? (
        <section className={styles.emptyPanel}>
          <IconPhone size={32} />
          <h2>{snapshot?.count ? t('phone_pool.no_matches') : t('phone_pool.empty')}</h2>
          <p>{snapshot?.count ? t('phone_pool.no_matches_hint') : t('phone_pool.empty_hint')}</p>
        </section>
      ) : (
        <section className={styles.grid} aria-label={t('phone_pool.list_label')}>
          {visiblePhones.map((phone) => {
            const response = responses[phone.id];
            return (
              <article className={styles.phoneCard} key={phone.id}>
                <div className={styles.cardHeader}>
                  <div className={styles.phoneIdentity}>
                    <span className={styles.phoneIcon}>
                      <IconPhone size={19} />
                    </span>
                    <div>
                      <strong>{phone.number}</strong>
                      <span>
                        {phone.enabled ? t('phone_pool.available') : t('phone_pool.disabled')}
                      </span>
                    </div>
                  </div>
                  <span
                    className={`${styles.statusBadge} ${
                      phone.enabled ? styles.availableBadge : styles.disabledBadge
                    }`}
                  >
                    {phone.enabled ? t('phone_pool.available') : t('phone_pool.disabled')}
                  </span>
                </div>

                <div className={styles.bindingStats}>
                  <div>
                    <span>{t('phone_pool.binding_count')}</span>
                    <strong>{phone.bindingCount}</strong>
                  </div>
                  <div>
                    <span>{t('phone_pool.baseline_count')}</span>
                    <strong>{phone.baselineBindings}</strong>
                  </div>
                  <div>
                    <span>{t('phone_pool.current_count')}</span>
                    <strong>{phone.currentBindings}</strong>
                  </div>
                </div>

                <div className={styles.cardActions}>
                  <Button
                    size="sm"
                    disabled={!phone.enabled || busyPhoneId === phone.id}
                    loading={busyPhoneId === phone.id}
                    onClick={() => void handleRequestCode(phone.id)}
                  >
                    {t('phone_pool.request_code')}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busyPhoneId === phone.id}
                    onClick={() => void handleToggleEnabled(phone.id, !phone.enabled)}
                  >
                    {phone.enabled ? t('phone_pool.disable') : t('phone_pool.enable')}
                  </Button>
                </div>

                {response && (
                  <div className={styles.responsePanel} aria-live="polite">
                    <div>
                      <strong>{t('phone_pool.provider_response')}</strong>
                      <span>
                        HTTP {response.providerStatus}
                        {response.truncated ? ` · ${t('phone_pool.truncated')}` : ''}
                      </span>
                    </div>
                    <pre>{response.body || t('phone_pool.empty_response')}</pre>
                    <small>
                      {t('phone_pool.response_time', {
                        time: new Date(response.fetchedAt).toLocaleString(),
                      })}
                    </small>
                  </div>
                )}
              </article>
            );
          })}
        </section>
      )}

      {snapshot?.updatedAt && (
        <footer>
          {t('phone_pool.updated_at', {
            time: new Date(snapshot.updatedAt).toLocaleString(),
          })}
        </footer>
      )}

      <Modal
        open={importOpen}
        title={t('phone_pool.import_title')}
        onClose={closeImport}
        closeDisabled={importing}
        width={720}
        footer={
          <>
            <Button variant="secondary" onClick={closeImport} disabled={importing}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => void handleImport()} loading={importing}>
              {t('phone_pool.import_submit')}
            </Button>
          </>
        }
      >
        <div className={styles.importForm}>
          <p>{t('phone_pool.import_description')}</p>
          <label htmlFor="phone-pool-import">{t('phone_pool.import_rows')}</label>
          <textarea
            id="phone-pool-import"
            value={importSource}
            onChange={(event) => {
              setImportSource(event.target.value);
              setImportError('');
            }}
            rows={11}
            autoComplete="off"
            spellCheck={false}
            placeholder={t('phone_pool.import_placeholder')}
          />
          <small>{t('phone_pool.import_security_hint')}</small>
          <label htmlFor="phone-pool-baseline">{t('phone_pool.baseline_input')}</label>
          <input
            id="phone-pool-baseline"
            className={styles.numberInput}
            type="number"
            min={0}
            step={1}
            value={baselineBindings}
            onChange={(event) => {
              setBaselineBindings(Number(event.target.value));
              setImportError('');
            }}
          />
          <small>{t('phone_pool.baseline_hint')}</small>
          {importError && <div className={styles.errorBox}>{importError}</div>}
        </div>
      </Modal>
    </div>
  );
}
