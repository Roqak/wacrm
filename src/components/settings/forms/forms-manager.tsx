'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import {
  ClipboardList,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
} from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { loadForms } from '@/components/interactive/flow-form-editor';
import type { WhatsAppFlow, WhatsAppFlowStatus } from '@/types';
import { SettingsPanelHead } from '../settings-panel-head';
import { CreateFormDialog } from './create-form-dialog';
import { FormDetailDialog } from './form-detail-dialog';
import { apiJson } from './api';

export const FLOW_STATUS_CLASS: Record<WhatsAppFlowStatus, string> = {
  DRAFT: 'border-slate-500/30 bg-slate-500/10 text-muted-foreground',
  PUBLISHED: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
  DEPRECATED: 'border-amber-500/30 bg-amber-500/10 text-amber-400',
  BLOCKED: 'border-red-500/30 bg-red-500/10 text-red-400',
  THROTTLED: 'border-orange-500/30 bg-orange-500/10 text-orange-400',
};

export interface EndpointKeyState {
  configured: boolean;
  public_key: string | null;
  uploaded_at: string | null;
  meta_signature_status?: string | null;
  meta_key_matches?: boolean | null;
  endpoint_path: string;
}

/**
 * Settings → WhatsApp Forms. Meta WhatsApp Flows, named "forms" in the
 * UI because "Flows" is the chatbot builder. Lists the account's forms
 * (synced from Meta or created here), opens a detail view per form,
 * and manages the account's data-endpoint encryption key.
 */
export function FormsManager() {
  const t = useTranslations('Settings.forms');
  const { accountRole } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;

  const [forms, setForms] = useState<WhatsAppFlow[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [keyState, setKeyState] = useState<EndpointKeyState | null>(null);
  const [rotating, setRotating] = useState(false);

  const reload = useCallback(async () => {
    try {
      const body = await apiJson<{ flows: WhatsAppFlow[] }>('/api/whatsapp/flows');
      setForms(body.flows);
      // Builders elsewhere on the page share a cached list — refresh it.
      void loadForms(true).catch(() => null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  const reloadKey = useCallback(async () => {
    try {
      setKeyState(await apiJson<EndpointKeyState>('/api/whatsapp/flows/endpoint-key'));
    } catch {
      setKeyState(null);
    }
  }, []);

  useEffect(() => {
    void reload();
    void reloadKey();
  }, [reload, reloadKey]);

  const sync = async () => {
    setSyncing(true);
    try {
      const result = await apiJson<{
        total: number;
        inserted: number;
        updated: number;
        errors: { name: string; message: string }[];
      }>('/api/whatsapp/flows/sync', { method: 'POST' });
      if (result.errors.length > 0) {
        toast.warning(
          t('syncPartial', { ok: result.inserted + result.updated, failed: result.errors.length }),
          { description: result.errors.map((e) => `${e.name}: ${e.message}`).join('\n') },
        );
      } else {
        toast.success(t('syncDone', { count: result.total }));
      }
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('syncFailed'));
    } finally {
      setSyncing(false);
    }
  };

  const rotateKey = async () => {
    if (
      keyState?.configured &&
      !window.confirm(t('keyRotateConfirm'))
    ) {
      return;
    }
    setRotating(true);
    try {
      await apiJson('/api/whatsapp/flows/endpoint-key', { method: 'POST' });
      toast.success(t('keyGenerated'));
      await reloadKey();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('keyFailed'));
    } finally {
      setRotating(false);
    }
  };

  const openForm = forms.find((f) => f.id === openId) ?? null;

  return (
    <div>
      <SettingsPanelHead
        title={t('title')}
        description={t('description')}
        action={
          canEdit ? (
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={sync} disabled={syncing}>
                {syncing ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="size-3.5" />
                )}
                {t('sync')}
              </Button>
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus className="size-3.5" />
                {t('new')}
              </Button>
            </div>
          ) : null
        }
      />

      {loading ? (
        <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> {t('loading')}
        </div>
      ) : forms.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
            <ClipboardList className="size-8 text-muted-foreground" />
            <p className="font-medium text-foreground">{t('emptyTitle')}</p>
            <p className="max-w-md text-sm text-muted-foreground">{t('emptyBody')}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
          {forms.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setOpenId(f.id)}
              className="flex w-full items-center gap-3 bg-card px-4 py-3 text-left transition-colors hover:bg-muted/50"
            >
              <ClipboardList className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">{f.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {f.categories.map((c) => t(`categories.${c}`)).join(' · ') || '—'}
                  {f.field_mappings.length > 0
                    ? ` · ${t('mappedCount', { count: f.field_mappings.length })}`
                    : ''}
                </p>
              </div>
              {Array.isArray(f.validation_errors) && f.validation_errors.length > 0 && (
                <Badge variant="outline" className="border-red-500/30 bg-red-500/10 text-red-400">
                  {t('errorsCount', { count: f.validation_errors.length })}
                </Badge>
              )}
              <Badge variant="outline" className={FLOW_STATUS_CLASS[f.status]}>
                {t(`status.${f.status}`)}
              </Badge>
            </button>
          ))}
        </div>
      )}

      <Card className="mt-6">
        <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center">
          <KeyRound className="size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">{t('keyTitle')}</p>
            <p className="text-xs text-muted-foreground">
              {keyState?.configured
                ? t('keyConfigured', {
                    date: keyState.uploaded_at
                      ? new Date(keyState.uploaded_at).toLocaleString()
                      : '—',
                  })
                : t('keyMissing')}
              {keyState?.meta_key_matches === false ? ` ${t('keyMismatch')}` : ''}
            </p>
          </div>
          {canEdit && (
            <Button variant="outline" size="sm" onClick={rotateKey} disabled={rotating}>
              {rotating && <Loader2 className="size-3.5 animate-spin" />}
              {keyState?.configured ? t('keyRotate') : t('keyGenerate')}
            </Button>
          )}
        </CardContent>
      </Card>

      {creating && (
        <CreateFormDialog
          // Reload even on close: a failed publish-at-create still leaves
          // the draft saved (see createWaFlow), and the list must show it.
          onClose={() => {
            setCreating(false);
            void reload();
          }}
          onCreated={async (flow) => {
            setCreating(false);
            await reload();
            setOpenId(flow.id);
          }}
        />
      )}

      {openForm && (
        <FormDetailDialog
          flow={openForm}
          canEdit={canEdit}
          keyState={keyState}
          onClose={() => setOpenId(null)}
          onChanged={(updated) =>
            setForms((prev) => prev.map((f) => (f.id === updated.id ? updated : f)))
          }
          onDeleted={async () => {
            setOpenId(null);
            await reload();
          }}
        />
      )}
    </div>
  );
}
