'use client';

// ============================================================
// WebhookEndpointsManager — Settings → Webhooks
//
// Dashboard CRUD for outgoing webhook endpoints (the
// `webhook_endpoints` table, migration 028). Until now those were only
// manageable with an API key over /api/v1/webhooks; this panel drives
// the new session-auth /api/webhook-endpoints routes instead, so an
// admin never needs a key to register a sink.
//
// Contract mirrors the public API (same validation, same shapes):
//   - url must be a valid https:// URL (SSRF + encryption reasons).
//   - events is a non-empty subset of WEBHOOK_EVENTS.
//   - the signing secret (`whsec_…`) is shown ONCE in the creation
//     dialog, like API keys — nothing can resurface it later.
//   - delivery disables an endpoint after max consecutive failures
//     (server-side); the panel shows that state and lets an admin
//     re-enable it (which also resets the failure streak).
//
// Roster visible to any member; mutations admin+ (RequireRole, and
// enforced again server-side).
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Copy, Loader2, Pencil, Plus, Trash2, Webhook } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { RequireRole } from '@/components/auth/require-role';
import {
  WEBHOOK_EVENT_DESCRIPTIONS,
  WEBHOOK_EVENTS,
} from '@/lib/webhooks/events';
import type { ApiWebhookEndpoint } from '@/lib/webhooks/endpoints';
import { SettingsPanelHead } from './settings-panel-head';

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function WebhookEndpointsManager() {
  const t = useTranslations('Settings.webhooks');
  const [endpoints, setEndpoints] = useState<ApiWebhookEndpoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<ApiWebhookEndpoint | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/webhook-endpoints', { cache: 'no-store' });
      const payload = await res.json().catch(() => ({}));
      if (res.ok) {
        setEndpoints((payload.endpoints as ApiWebhookEndpoint[]) ?? []);
      } else {
        toast.error((payload.error as string) || t('loadFailed'));
      }
    } catch {
      toast.error(t('networkError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleDelete(target: ApiWebhookEndpoint) {
    setDeleting(target.id);
    try {
      const res = await fetch(`/api/webhook-endpoints/${target.id}`, {
        method: 'DELETE',
      });
      const payload = await res.json().catch(() => ({}));
      if (res.ok) {
        setEndpoints((prev) => prev.filter((e) => e.id !== target.id));
        toast.success(t('deleteSuccess'));
      } else {
        toast.error((payload.error as string) || t('deleteFailed'));
      }
    } catch {
      toast.error(t('networkError'));
    } finally {
      setDeleting(null);
    }
  }

  async function handleToggle(target: ApiWebhookEndpoint, next: boolean) {
    setToggling(target.id);
    try {
      const res = await fetch(`/api/webhook-endpoints/${target.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: next }),
      });
      const payload = await res.json().catch(() => ({}));
      if (res.ok) {
        setEndpoints((prev) =>
          prev.map((e) =>
            e.id === target.id
              ? (payload.endpoint as ApiWebhookEndpoint) ?? e
              : e,
          ),
        );
        toast.success(next ? t('enabled') : t('disabled'));
      } else {
        toast.error((payload.error as string) || t('updateFailed'));
      }
    } catch {
      toast.error(t('networkError'));
    } finally {
      setToggling(null);
    }
  }

  function upsertLocal(updated: ApiWebhookEndpoint) {
    setEndpoints((prev) => prev.map((e) => (e.id === updated.id ? updated : e)));
  }

  return (
    <section className="animate-in fade-in-50 space-y-6 duration-200">
      <SettingsPanelHead
        title={t('title')}
        description={t('description')}
        action={
          <RequireRole min="admin">
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" />
              {t('newWebhook')}
            </Button>
          </RequireRole>
        }
      />

      <p className="text-muted-foreground -mt-2 text-xs">
        {t('secretNote')}
      </p>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="text-primary size-6 animate-spin" />
        </div>
      ) : endpoints.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-10 text-center">
            <Webhook className="text-muted-foreground size-6" />
            <p className="text-muted-foreground mt-2 text-sm">{t('emptyTitle')}</p>
            <p className="text-muted-foreground mt-1 text-xs">{t('emptyDesc')}</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul className="divide-border divide-y">
              {endpoints.map((ep) => (
                <li
                  key={ep.id}
                  className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-start sm:gap-4"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`truncate font-mono text-sm ${
                          ep.is_active
                            ? 'text-foreground'
                            : 'text-muted-foreground line-through'
                        }`}
                      >
                        {ep.url}
                      </span>
                      {!ep.is_active && (
                        <Badge className="border-border bg-muted text-muted-foreground text-[10px] tracking-wide uppercase">
                          {ep.failure_count > 0
                            ? t('disabledBadge')
                            : t('inactiveBadge')}
                        </Badge>
                      )}
                    </div>

                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {ep.events.length === 0 ? (
                        <span className="text-muted-foreground text-xs">
                          {t('noEvents')}
                        </span>
                      ) : (
                        ep.events.map((ev) => (
                          <Badge
                            key={ev}
                            className="border-border bg-muted text-muted-foreground text-[10px]"
                          >
                            {ev}
                          </Badge>
                        ))
                      )}
                    </div>

                    <p className="text-muted-foreground mt-1.5 text-xs">
                      {t('created', { date: fmtDate(ep.created_at) })}
                      {' · '}
                      {ep.last_delivery_at
                        ? t('lastDelivery', { date: fmtDate(ep.last_delivery_at) })
                        : t('neverDelivered')}
                      {ep.failure_count > 0
                        ? ` · ${t('failures', { count: ep.failure_count })}`
                        : ''}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-2 self-start sm:self-center">
                    <RequireRole min="admin">
                      <Switch
                        checked={ep.is_active}
                        onCheckedChange={(next) => handleToggle(ep, next)}
                        disabled={toggling === ep.id}
                        aria-label={t('toggleAria')}
                      />
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() => setEditing(ep)}
                        aria-label={t('editAria')}
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() => handleDelete(ep)}
                        disabled={deleting === ep.id}
                        className="border-red-500/40 bg-red-500/10 text-red-300 hover:border-red-500/60 hover:bg-red-500/20 hover:text-red-200"
                        aria-label={t('deleteAria')}
                      >
                        {deleting === ep.id ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <Trash2 className="size-4" />
                        )}
                      </Button>
                    </RequireRole>
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <EndpointDialog
        key={createOpen ? 'create' : 'closed'}
        open={createOpen}
        mode="create"
        onClose={() => setCreateOpen(false)}
        onSaved={load}
      />

      {editing && (
        <EndpointDialog
          key={editing.id}
          open
          mode="edit"
          endpoint={editing}
          onClose={() => setEditing(null)}
          onSaved={(updated) => {
            upsertLocal(updated);
            load();
          }}
        />
      )}
    </section>
  );
}

// ------------------------------------------------------------
// Create dialog — url + event checkboxes → one-time secret reveal.
// Edit dialog — same form prefilled, minus the secret step.
// ------------------------------------------------------------

function EndpointDialog({
  open,
  mode,
  endpoint,
  onClose,
  onSaved,
}: {
  open: boolean;
  mode: 'create' | 'edit';
  endpoint?: ApiWebhookEndpoint;
  onClose: () => void;
  onSaved: (endpoint: ApiWebhookEndpoint) => void;
}) {
  const t = useTranslations('Settings.webhooks');
  const [url, setUrl] = useState(endpoint?.url ?? '');
  const [events, setEvents] = useState<string[]>(endpoint?.events ?? []);
  const [submitting, setSubmitting] = useState(false);
  // Once set, the create dialog switches to the reveal view.
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);

  function toggleEvent(ev: string, checked: boolean) {
    setEvents((prev) =>
      checked ? [...prev, ev] : prev.filter((e) => e !== ev),
    );
  }

  async function handleSave() {
    const trimmed = url.trim();
    if (!trimmed) {
      toast.error(t('urlRequired'));
      return;
    }
    if (events.length === 0) {
      toast.error(t('eventsRequired'));
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(
        mode === 'create'
          ? '/api/webhook-endpoints'
          : `/api/webhook-endpoints/${endpoint?.id}`,
        {
          method: mode === 'create' ? 'POST' : 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: trimmed, events }),
        },
      );
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error((payload.error as string) || t('saveFailed'));
        return;
      }
      if (mode === 'create') {
        // The list refreshes behind the dialog; the secret is the reveal step.
        setCreatedSecret(payload.secret as string);
      }
      onSaved(payload.endpoint as ApiWebhookEndpoint);
    } catch {
      toast.error(t('networkError'));
    } finally {
      setSubmitting(false);
    }
  }

  async function copySecret() {
    if (!createdSecret) return;
    try {
      await navigator.clipboard.writeText(createdSecret);
      toast.success(t('copySuccess'));
    } catch {
      toast.error(t('copyFailed'));
    }
  }

  const reveal = mode === 'create' && createdSecret != null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="border-border bg-popover sm:max-w-md">
        {reveal ? (
          <>
            <DialogHeader>
              <DialogTitle className="text-popover-foreground">
                {t('copyTitle')}
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                {t('copyDesc')}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-1.5">
              <Label className="text-muted-foreground">
                {t('secretLabel')}
              </Label>
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={createdSecret}
                  className="font-mono text-xs"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Button type="button" variant="outline" onClick={copySecret}>
                  <Copy className="size-4" />
                  {t('copy')}
                </Button>
              </div>
            </div>

            <DialogFooter>
              <Button
                onClick={() => {
                  onClose();
                }}
              >
                {t('done')}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="text-popover-foreground">
                {mode === 'create' ? t('newWebhookTitle') : t('editTitle')}
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                {mode === 'create' ? t('newWebhookDesc') : t('editDesc')}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="webhook-url" className="text-muted-foreground">
                  {t('urlLabel')}
                </Label>
                <Input
                  id="webhook-url"
                  value={url}
                  type="url"
                  inputMode="url"
                  placeholder="https://example.com/hooks/wacrm"
                  onChange={(e) => setUrl(e.target.value)}
                />
                <p className="text-muted-foreground text-xs">
                  {t('urlHint')}
                </p>
              </div>

              <div className="space-y-2">
                <Label className="text-muted-foreground">{t('eventsLabel')}</Label>
                <div className="border-border space-y-2 rounded-md border p-3">
                  {WEBHOOK_EVENTS.map((ev) => (
                    <label
                      key={ev}
                      className="flex cursor-pointer items-start gap-2.5"
                    >
                      <Checkbox
                        checked={events.includes(ev)}
                        onCheckedChange={(checked) => toggleEvent(ev, checked === true)}
                        className="mt-0.5"
                      />
                      <span className="min-w-0">
                        <span className="text-foreground block font-mono text-xs">
                          {ev}
                        </span>
                        <span className="text-muted-foreground block text-xs">
                          {WEBHOOK_EVENT_DESCRIPTIONS[ev]}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                onClick={onClose}
                className="border-border text-muted-foreground hover:bg-muted"
              >
                {t('cancel')}
              </Button>
              <Button onClick={handleSave} disabled={submitting}>
                {submitting ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : null}
                {t('save')}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}