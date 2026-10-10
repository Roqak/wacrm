'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import {
  Copy,
  Download,
  ExternalLink,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  formatFieldValue,
  humanizeFieldName,
  listFieldNames,
  listScreenIds,
  entryScreenOf,
} from '@/lib/whatsapp/wa-flows/definition';
import type { WhatsAppFlow, WhatsAppFlowFieldMapping } from '@/types';
import { apiJson } from './api';
import { FLOW_STATUS_CLASS, type EndpointKeyState } from './forms-manager';
import { ValidationErrorList, type FlowValidationError } from './validation-errors';
import { AiFormAssist, FlowLintSummary } from './ai-assist';

/** The editor's JSON as an object, or null while it doesn't parse. */
function parsedOrNull(json: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(json);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

type Tab = 'overview' | 'definition' | 'mapping' | 'endpoint' | 'responses';

interface Props {
  flow: WhatsAppFlow;
  canEdit: boolean;
  keyState: EndpointKeyState | null;
  onClose: () => void;
  onChanged: (flow: WhatsAppFlow) => void;
  onDeleted: () => void;
}

/** Detail view for one WhatsApp Form, tabbed by concern. */
export function FormDetailDialog(props: Props) {
  const { flow, onClose } = props;
  const t = useTranslations('Settings.forms');
  const [tab, setTab] = useState<Tab>('overview');

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="truncate">{flow.name}</span>
            <Badge variant="outline" className={FLOW_STATUS_CLASS[flow.status]}>
              {t(`status.${flow.status}`)}
            </Badge>
          </DialogTitle>
          <DialogDescription className="font-mono text-xs">
            {t('metaId', { id: flow.meta_flow_id })}
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
          <TabsList className="w-full overflow-x-auto">
            <TabsTrigger value="overview">{t('tabOverview')}</TabsTrigger>
            <TabsTrigger value="definition">{t('tabDefinition')}</TabsTrigger>
            <TabsTrigger value="mapping">{t('tabMapping')}</TabsTrigger>
            <TabsTrigger value="endpoint">{t('tabEndpoint')}</TabsTrigger>
            <TabsTrigger value="responses">{t('tabResponses')}</TabsTrigger>
          </TabsList>
          <TabsContent value="overview" className="pt-3">
            <OverviewTab {...props} />
          </TabsContent>
          <TabsContent value="definition" className="pt-3">
            <DefinitionTab {...props} />
          </TabsContent>
          <TabsContent value="mapping" className="pt-3">
            <MappingTab {...props} />
          </TabsContent>
          <TabsContent value="endpoint" className="pt-3">
            <EndpointTab {...props} />
          </TabsContent>
          <TabsContent value="responses" className="pt-3">
            {tab === 'responses' && <ResponsesTab flow={flow} />}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------
// Overview — status actions, opening screen, preview
// ------------------------------------------------------------

function OverviewTab({ flow, canEdit, onChanged, onDeleted }: Props) {
  const t = useTranslations('Settings.forms');
  const [busy, setBusy] = useState<string | null>(null);
  const screens = listScreenIds(flow.flow_json);
  const entry = entryScreenOf(flow.flow_json);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const action = (name: 'publish' | 'deprecate' | 'refresh', confirmKey?: string) =>
    run(name, async () => {
      if (confirmKey && !window.confirm(t(confirmKey))) return;
      const { flow: updated } = await apiJson<{ flow: WhatsAppFlow }>(
        `/api/whatsapp/flows/${flow.id}/${name}`,
        { method: 'POST' },
      );
      onChanged(updated);
      toast.success(t(`${name}Done`));
    });

  const remove = () =>
    run('delete', async () => {
      if (!window.confirm(t(flow.status === 'DRAFT' ? 'deleteDraftConfirm' : 'removeConfirm'))) {
        return;
      }
      await apiJson(`/api/whatsapp/flows/${flow.id}`, { method: 'DELETE' });
      toast.success(t('deleted'));
      onDeleted();
    });

  const preview = () =>
    run('preview', async () => {
      const { preview_url } = await apiJson<{ preview_url: string }>(
        `/api/whatsapp/flows/${flow.id}/preview`,
      );
      window.open(preview_url, '_blank', 'noopener,noreferrer');
    });

  const setFirstScreen = (screen: string) =>
    run('screen', async () => {
      const { flow: updated } = await apiJson<{ flow: WhatsAppFlow }>(
        `/api/whatsapp/flows/${flow.id}`,
        { method: 'PATCH', body: JSON.stringify({ first_screen: screen || null }) },
      );
      onChanged(updated);
    });

  const spinner = (key: string) =>
    busy === key ? <Loader2 className="size-3.5 animate-spin" /> : null;

  return (
    <div className="space-y-5">
      <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs text-muted-foreground">{t('categoriesLabel')}</dt>
          <dd className="text-foreground">
            {flow.categories.map((c) => t(`categories.${c}`)).join(', ') || '—'}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('screens')}</dt>
          <dd className="font-mono text-xs text-foreground">{screens.join(' → ') || '—'}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('jsonVersion')}</dt>
          <dd className="text-foreground">{flow.json_version ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('lastSynced')}</dt>
          <dd className="text-foreground">
            {flow.synced_at ? new Date(flow.synced_at).toLocaleString() : '—'}
          </dd>
        </div>
      </dl>

      {screens.length > 1 && (
        <div className="space-y-1.5">
          <Label>{t('firstScreen')}</Label>
          <select
            value={flow.first_screen ?? ''}
            disabled={!canEdit || busy !== null}
            onChange={(e) => setFirstScreen(e.target.value)}
            className="h-9 w-full rounded-md border border-border bg-muted px-2 text-sm text-foreground sm:w-72"
          >
            <option value="">{t('firstScreenDefault', { screen: entry ?? '—' })}</option>
            {screens.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">{t('firstScreenHelp')}</p>
        </div>
      )}

      {Array.isArray(flow.validation_errors) && flow.validation_errors.length > 0 && (
        <ValidationErrorList errors={flow.validation_errors as FlowValidationError[]} />
      )}

      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={preview} disabled={busy !== null}>
          {spinner('preview') ?? <ExternalLink className="size-3.5" />}
          {t('preview')}
        </Button>
        {canEdit && (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => action('refresh')}
              disabled={busy !== null}
            >
              {spinner('refresh') ?? <RefreshCw className="size-3.5" />}
              {t('refresh')}
            </Button>
            {flow.status === 'DRAFT' && (
              <Button
                size="sm"
                onClick={() => action('publish', 'publishConfirm')}
                disabled={busy !== null}
              >
                {spinner('publish')}
                {t('publish')}
              </Button>
            )}
            {flow.status === 'PUBLISHED' && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => action('deprecate', 'deprecateConfirm')}
                disabled={busy !== null}
              >
                {spinner('deprecate')}
                {t('deprecate')}
              </Button>
            )}
            {flow.status !== 'PUBLISHED' && (
              <Button
                variant="ghost"
                size="sm"
                onClick={remove}
                disabled={busy !== null}
                className="text-red-400 hover:bg-red-500/10 hover:text-red-300"
              >
                {spinner('delete') ?? <Trash2 className="size-3.5" />}
                {flow.status === 'DRAFT' ? t('delete') : t('remove')}
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------
// Definition — Flow JSON editor (drafts only)
// ------------------------------------------------------------

function DefinitionTab({ flow, canEdit, onChanged }: Props) {
  const t = useTranslations('Settings.forms');
  const editable = canEdit && flow.status === 'DRAFT';
  const original = useMemo(
    () => (flow.flow_json ? JSON.stringify(flow.flow_json, null, 2) : ''),
    [flow.flow_json],
  );
  const [json, setJson] = useState(original);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<FlowValidationError[]>([]);
  const [metaStale, setMetaStale] = useState(false);

  useEffect(() => setJson(original), [original]);

  const save = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (e) {
      toast.error(t('jsonInvalid', { message: e instanceof Error ? e.message : '' }));
      return;
    }
    setSaving(true);
    try {
      const result = await apiJson<{
        flow: WhatsAppFlow;
        validation_errors: FlowValidationError[];
      }>(`/api/whatsapp/flows/${flow.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ flow_json: parsed }),
      });
      setErrors(result.validation_errors);
      setMetaStale(false);
      onChanged(result.flow);
      if (result.validation_errors.length > 0) toast.warning(t('savedWithErrors'));
      else toast.success(t('saved'));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {editable ? t('definitionHelp') : t('definitionFrozen')}
      </p>
      {editable && (
        <AiFormAssist
          currentJson={parsedOrNull(json) ?? flow.flow_json}
          metaErrors={
            // Meta's errors describe the SAVED definition; once the AI
            // has rewritten the editor they no longer apply until the
            // next save re-validates.
            metaStale
              ? []
              : errors.length > 0
                ? errors
                : Array.isArray(flow.validation_errors)
                  ? (flow.validation_errors as FlowValidationError[])
                  : []
          }
          onResult={(result) => {
            setJson(JSON.stringify(result.flow_json, null, 2));
            setErrors([]);
            setMetaStale(true);
          }}
        />
      )}
      <Textarea
        value={json}
        onChange={(e) => setJson(e.target.value)}
        readOnly={!editable}
        spellCheck={false}
        placeholder={t('definitionEmpty')}
        className="min-h-96 font-mono text-xs"
      />
      <FlowLintSummary json={json} />
      <ValidationErrorList errors={errors} />
      {editable && (
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => setJson(original)} disabled={saving}>
            {t('reset')}
          </Button>
          <Button size="sm" onClick={save} disabled={saving || json === original}>
            {saving && <Loader2 className="size-3.5 animate-spin" />}
            {t('saveDefinition')}
          </Button>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------
// Mapping — submitted field → contact field
// ------------------------------------------------------------

function MappingTab({ flow, canEdit, onChanged }: Props) {
  const t = useTranslations('Settings.forms');
  const { accountId } = useAuth();
  const [mappings, setMappings] = useState<WhatsAppFlowFieldMapping[]>(flow.field_mappings);
  const [customFields, setCustomFields] = useState<{ id: string; field_name: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const fieldNames = listFieldNames(flow.flow_json);

  useEffect(() => setMappings(flow.field_mappings), [flow.field_mappings]);
  useEffect(() => {
    if (!accountId) return;
    void createClient()
      .from('custom_fields')
      .select('id, field_name')
      .eq('account_id', accountId)
      .order('field_name')
      .then(({ data }) => setCustomFields((data ?? []) as { id: string; field_name: string }[]));
  }, [accountId]);

  const targets = [
    { value: 'name', label: t('targetName') },
    { value: 'email', label: t('targetEmail') },
    { value: 'company', label: t('targetCompany') },
    ...customFields.map((f) => ({ value: `custom:${f.id}`, label: f.field_name })),
  ];

  const update = (i: number, patch: Partial<WhatsAppFlowFieldMapping>) =>
    setMappings((prev) => prev.map((m, j) => (j === i ? { ...m, ...patch } : m)));

  const save = async () => {
    setSaving(true);
    try {
      const { flow: updated } = await apiJson<{ flow: WhatsAppFlow }>(
        `/api/whatsapp/flows/${flow.id}`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            field_mappings: mappings.filter((m) => m.field && m.target),
          }),
        },
      );
      onChanged(updated);
      toast.success(t('mappingSaved'));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const selectClass =
    'h-9 min-w-0 flex-1 rounded-md border border-border bg-muted px-2 text-sm text-foreground';

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{t('mappingHelp')}</p>
      {mappings.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('mappingEmpty')}</p>
      )}
      {mappings.map((m, i) => (
        <div key={i} className="flex items-center gap-2">
          {fieldNames.length > 0 ? (
            <select
              value={m.field}
              disabled={!canEdit}
              onChange={(e) => update(i, { field: e.target.value })}
              className={selectClass}
            >
              <option value="">{t('mappingPickField')}</option>
              {fieldNames.map((f) => (
                <option key={f} value={f}>
                  {humanizeFieldName(f)} ({f})
                </option>
              ))}
            </select>
          ) : (
            <Input
              value={m.field}
              disabled={!canEdit}
              onChange={(e) => update(i, { field: e.target.value })}
              placeholder={t('mappingFieldPlaceholder')}
              className="flex-1 font-mono text-xs"
            />
          )}
          <span className="text-muted-foreground">→</span>
          <select
            value={m.target}
            disabled={!canEdit}
            onChange={(e) => update(i, { target: e.target.value })}
            className={selectClass}
          >
            <option value="">{t('mappingPickTarget')}</option>
            {targets.map((tg) => (
              <option key={tg.value} value={tg.value}>
                {tg.label}
              </option>
            ))}
          </select>
          {canEdit && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setMappings((prev) => prev.filter((_, j) => j !== i))}
              className="text-red-400 hover:bg-red-500/10"
            >
              <Trash2 className="size-3.5" />
            </Button>
          )}
        </div>
      ))}
      {canEdit && (
        <div className="flex justify-between gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setMappings((prev) => [...prev, { field: '', target: '' }])}
          >
            <Plus className="size-3.5" />
            {t('mappingAdd')}
          </Button>
          <Button size="sm" onClick={save} disabled={saving}>
            {saving && <Loader2 className="size-3.5 animate-spin" />}
            {t('mappingSave')}
          </Button>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------
// Endpoint — data exchange
// ------------------------------------------------------------

function EndpointTab({ flow, canEdit, keyState, onChanged }: Props) {
  const t = useTranslations('Settings.forms');
  const [forwardUrl, setForwardUrl] = useState(flow.endpoint_forward_url ?? '');
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const endpointUrl =
    typeof window !== 'undefined' && keyState
      ? `${window.location.origin}${keyState.endpoint_path}`
      : '';
  const connected = Boolean(flow.endpoint_uri && endpointUrl && flow.endpoint_uri === endpointUrl);

  const patch = async (key: string, body: Record<string, unknown>) => {
    setBusy(key);
    try {
      const result = await apiJson<{ flow: WhatsAppFlow; forward_secret?: string }>(
        `/api/whatsapp/flows/${flow.id}`,
        { method: 'PATCH', body: JSON.stringify(body) },
      );
      onChanged(result.flow);
      if (result.forward_secret) setSecret(result.forward_secret);
      toast.success(t('saved'));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const copy = (text: string) => {
    void navigator.clipboard.writeText(text);
    toast.success(t('copied'));
  };

  return (
    <div className="space-y-5">
      <p className="text-xs text-muted-foreground">{t('endpointHelp')}</p>

      {!keyState?.configured && (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-400">
          {t('endpointNeedsKey')}
        </p>
      )}

      <div className="space-y-1.5">
        <Label>{t('endpointUrl')}</Label>
        <div className="flex gap-2">
          <Input value={endpointUrl} readOnly className="font-mono text-xs" />
          <Button variant="outline" size="sm" onClick={() => copy(endpointUrl)}>
            <Copy className="size-3.5" />
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {flow.endpoint_uri
            ? connected
              ? t('endpointConnected')
              : t('endpointOther', { uri: flow.endpoint_uri })
            : t('endpointNone')}
        </p>
        {canEdit && !connected && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null || !endpointUrl || !endpointUrl.startsWith('https://')}
            onClick={() => patch('connect', { endpoint_uri: endpointUrl })}
          >
            {busy === 'connect' && <Loader2 className="size-3.5 animate-spin" />}
            {t('endpointConnect')}
          </Button>
        )}
      </div>

      <div className="space-y-1.5">
        <Label>{t('forwardUrl')}</Label>
        <p className="text-xs text-muted-foreground">{t('forwardHelp')}</p>
        <div className="flex gap-2">
          <Input
            value={forwardUrl}
            onChange={(e) => setForwardUrl(e.target.value)}
            disabled={!canEdit}
            placeholder="https://api.example.com/forms/handler"
            className="font-mono text-xs"
          />
          {canEdit && (
            <Button
              size="sm"
              disabled={busy !== null || forwardUrl === (flow.endpoint_forward_url ?? '')}
              onClick={() => patch('forward', { endpoint_forward_url: forwardUrl.trim() || null })}
            >
              {busy === 'forward' && <Loader2 className="size-3.5 animate-spin" />}
              {t('save')}
            </Button>
          )}
        </div>
        {secret && (
          <div className="space-y-1 rounded-lg border border-primary/30 bg-primary/5 p-3">
            <p className="text-xs text-foreground">{t('forwardSecretOnce')}</p>
            <div className="flex gap-2">
              <Input value={secret} readOnly className="font-mono text-xs" />
              <Button variant="outline" size="sm" onClick={() => copy(secret)}>
                <Copy className="size-3.5" />
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------
// Responses
// ------------------------------------------------------------

interface ResponseRow {
  id: string;
  response: Record<string, unknown>;
  created_at: string;
  conversation_id: string | null;
  contact: { id: string; name: string | null; phone: string | null } | null;
}

function ResponsesTab({ flow }: { flow: WhatsAppFlow }) {
  const t = useTranslations('Settings.forms');
  const [rows, setRows] = useState<ResponseRow[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (before?: string) => {
      setLoading(true);
      try {
        const qs = before ? `?before=${encodeURIComponent(before)}` : '';
        const body = await apiJson<{ responses: ResponseRow[]; next_before: string | null }>(
          `/api/whatsapp/flows/${flow.id}/responses${qs}`,
        );
        setRows((prev) => (before ? [...prev, ...body.responses] : body.responses));
        setNext(body.next_before);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [flow.id],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const columns = useMemo(() => {
    const seen = new Set<string>(listFieldNames(flow.flow_json));
    for (const r of rows) Object.keys(r.response ?? {}).forEach((k) => seen.add(k));
    return [...seen].filter((k) => rows.some((r) => r.response?.[k] !== undefined));
  }, [rows, flow.flow_json]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">{t('responsesHelp')}</p>
        <a
          href={`/api/whatsapp/flows/${flow.id}/responses?format=csv`}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs text-foreground hover:bg-muted"
        >
          <Download className="size-3.5" />
          {t('downloadCsv')}
        </a>
      </div>
      {rows.length === 0 && !loading ? (
        <p className="py-6 text-center text-sm text-muted-foreground">{t('responsesEmpty')}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-xs">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">{t('responseContact')}</th>
                <th className="px-3 py-2 font-medium">{t('responseDate')}</th>
                {columns.map((c) => (
                  <th key={c} className="px-3 py-2 font-medium">
                    {humanizeFieldName(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {r.conversation_id ? (
                      <a
                        href={`/inbox?c=${r.conversation_id}`}
                        className="text-primary hover:underline"
                      >
                        {r.contact?.name || r.contact?.phone || '—'}
                      </a>
                    ) : (
                      r.contact?.name || r.contact?.phone || '—'
                    )}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                    {new Date(r.created_at).toLocaleString()}
                  </td>
                  {columns.map((c) => (
                    <td key={c} className="max-w-56 truncate px-3 py-2 text-foreground">
                      {formatFieldValue(r.response?.[c])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {loading && (
        <div className="flex justify-center py-2">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        </div>
      )}
      {next && !loading && (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" onClick={() => load(next)}>
            {t('loadMore')}
          </Button>
        </div>
      )}
    </div>
  );
}
