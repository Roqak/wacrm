'use client';

// ============================================================
// WebhookEventsPanel — Settings → Webhook events (migration 047).
//
// The inbound WhatsApp event trail, live. Two sources feed the list:
//   1. GET /api/whatsapp/webhook/logs — the initial page, newest first.
//   2. A Supabase Realtime subscription on INSERT — every event admits
//      itself through the table's RLS evaluated with this browser's
//      token, so the stream carries exactly what GET returned: this
//      account's events plus the account-less drops.
//
// Everything is admin-gated: `<RequireRole min="admin">` fails closed
// while the role is unknown and renders nothing for agents/viewers
// (the rail entry stays visible — the whole rail is ungated, matching
// the API-keys section's behaviour).
//
// `payload` is Meta's own body. Rows default to collapsed: the
// summary line is what you scan; the body is what you expand when
// you need the exact bytes Meta sent.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { ChevronDown, Loader2, RadioTower } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { createClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';
import { RequireRole } from '@/components/auth/require-role';
import { SettingsPanelHead } from './settings-panel-head';
import type { WebhookEventLog } from '@/types';

const MAX_EVENTS = 200;

const EVENT_TYPE_STYLES: Record<WebhookEventLog['event_type'], string> = {
  message: 'bg-primary-soft text-primary',
  status: 'bg-muted text-muted-foreground',
  template: 'bg-secondary text-secondary-foreground',
  verification: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
  error: 'bg-destructive/10 text-destructive',
};

const STATUS_STYLES: Record<WebhookEventLog['status'], string> = {
  processed: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  ignored: 'bg-muted text-muted-foreground',
  dropped: 'bg-amber-500/10 text-amber-600 dark:text-amber-500',
  error: 'bg-destructive/10 text-destructive',
};

export function WebhookEventsPanel() {
  const t = useTranslations('Settings.webhookEvents');

  return (
    <>
      <SettingsPanelHead title={t('title')} description={t('description')} />
      <RequireRole min="admin">
        <WebhookEventsPanelBody />
      </RequireRole>
    </>
  );
}

function WebhookEventsPanelBody() {
  const t = useTranslations('Settings.webhookEvents');
  const [events, setEvents] = useState<WebhookEventLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [live, setLive] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const loadEvents = useCallback(async () => {
    try {
      const res = await fetch('/api/whatsapp/webhook/logs', {
        cache: 'no-store',
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('loadFailed'));
        return;
      }
      const data = (await res.json()) as { events: WebhookEventLog[] };
      setEvents(data.events);
    } catch (err) {
      console.error('[WebhookEventsPanel] load error:', err);
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  // Initial page…
  useEffect(() => {
    void loadEvents();
  }, [loadEvents]);

  // …then the live stream. A single INSERT filter; the table's RLS
  // policies admit only this session's visible rows, so no client-side
  // account filter is needed.
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel('webhook-events')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'whatsapp_webhook_logs' },
        (payload) => {
          const row = payload.new as WebhookEventLog;
          setEvents((prev) => [row, ...prev].slice(0, MAX_EVENTS));
        }
      )
      .subscribe((status) => {
        setLive(status === 'SUBSCRIBED');
      });
    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  // Keep the relative timestamps honest when the panel sits open.
  useEffect(() => {
    if (events.length === 0) return;
    const timer = setInterval(() => setEvents((prev) => [...prev]), 30_000);
    return () => clearInterval(timer);
  }, [events.length]);

  return (
    <div className="rounded-xl border border-border overflow-hidden">
      <div
        className={cn(
          'flex items-center gap-2 border-b border-border px-4 py-2.5 text-xs',
          live ? 'text-muted-foreground' : 'text-amber-600 dark:text-amber-500',
        )}
      >
        <RadioTower className="size-3.5" />
        <span>{live ? t('live') : t('connecting')}</span>
        <span className="flex-1" />
        <span className="tabular-nums">
          {t('showing', { count: events.length })}
        </span>
      </div>
      {loading ? (
        <div className="flex items-center gap-2 px-4 py-8 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> {t('loading')}
        </div>
      ) : events.length === 0 ? (
        <div className="px-4 py-8 text-sm text-muted-foreground">
          {t('empty')}
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {events.map((event) => (
            <WebhookEventRow
              key={event.id}
              event={event}
              expanded={expandedId === event.id}
              onToggle={() =>
                setExpandedId((cur) => (cur === event.id ? null : event.id))
              }
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function WebhookEventRow({
  event,
  expanded,
  onToggle,
}: {
  event: WebhookEventLog;
  expanded: boolean;
  onToggle: () => void;
}) {
  const t = useTranslations('Settings.webhookEvents');
  const hasBody =
    (event.payload != null && Object.keys(event.payload).length > 0) ||
    event.error != null;

  return (
    <li>
      <button
        type="button"
        onClick={hasBody ? onToggle : undefined}
        aria-expanded={hasBody ? expanded : undefined}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted/40"
      >
        <span className="flex shrink-0 gap-1.5">
          <span
            className={cn(
              'rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
              EVENT_TYPE_STYLES[event.event_type],
            )}
          >
            {t(`type.${event.event_type}`)}
          </span>
          <span
            className={cn(
              'rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
              STATUS_STYLES[event.status],
            )}
          >
            {t(`status.${event.status}`)}
          </span>
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">
          {event.summary ?? t('unlabeled')}
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
          {formatDistanceToNow(new Date(event.created_at), {
            addSuffix: true,
          })}
        </span>
        {hasBody ? (
          <ChevronDown
            className={cn(
              'size-3.5 shrink-0 text-muted-foreground transition-transform',
              expanded && 'rotate-180',
            )}
          />
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
      </button>
      {expanded && hasBody ? (
        <div className="border-t border-border/60 px-4 py-3">
          {event.error ? (
            <p className="mb-2 text-xs text-destructive">{event.error}</p>
          ) : null}
          {event.payload != null ? (
            <pre className="max-h-64 overflow-auto rounded-lg bg-muted/50 p-3 text-[11px] leading-relaxed text-muted-foreground">
              {JSON.stringify(event.payload, null, 2)}
            </pre>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}