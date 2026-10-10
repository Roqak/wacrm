'use client';

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { AlertTriangle, CheckCircle2, Loader2, Sparkles, Wand2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { lintFlowJson, type FlowLintIssue } from '@/lib/whatsapp/wa-flows/lint';
import { apiJson } from './api';
import type { FlowValidationError } from './validation-errors';

export interface AiFormResult {
  name: string | null;
  categories: string[];
  flow_json: Record<string, unknown>;
  issues: FlowLintIssue[];
  attempts: number;
}

function callBuilder(body: {
  instruction: string;
  current_json?: unknown;
  meta_errors?: FlowValidationError[];
}): Promise<AiFormResult> {
  return apiJson<AiFormResult>('/api/whatsapp/flows/ai', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/**
 * "Describe your form" box. With no `currentJson` it creates a form
 * from scratch; with one it edits it. When `metaErrors` are present a
 * "Fix with AI" button sends Meta's own validation errors to the model.
 * The result is handed back for review — nothing is saved here.
 */
export function AiFormAssist({
  currentJson,
  metaErrors = [],
  onResult,
}: {
  currentJson?: Record<string, unknown> | null;
  metaErrors?: FlowValidationError[];
  onResult: (result: AiFormResult) => void;
}) {
  const t = useTranslations('Settings.forms');
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState<'generate' | 'fix' | null>(null);
  const editing = Boolean(currentJson);

  const run = async (mode: 'generate' | 'fix') => {
    setBusy(mode);
    try {
      const result = await callBuilder({
        instruction,
        current_json: currentJson ?? undefined,
        meta_errors: mode === 'fix' ? metaErrors : undefined,
      });
      onResult(result);
      const errors = result.issues.filter((i) => i.severity === 'error').length;
      if (errors > 0) toast.warning(t('aiIssuesLeft', { count: errors }));
      else toast.success(editing ? t('aiUpdated') : t('aiGenerated'));
      if (mode === 'generate') setInstruction('');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('aiFailed'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-3">
      <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
        <Sparkles className="size-4 text-primary" />
        {editing ? t('aiEditTitle') : t('aiCreateTitle')}
      </div>
      <Textarea
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        maxLength={4000}
        placeholder={editing ? t('aiEditPlaceholder') : t('aiCreatePlaceholder')}
        className="min-h-20 bg-background text-sm"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          onClick={() => run('generate')}
          disabled={busy !== null || !instruction.trim()}
        >
          {busy === 'generate' ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Sparkles className="size-3.5" />
          )}
          {busy === 'generate' ? t('aiWorking') : editing ? t('aiApply') : t('aiGenerate')}
        </Button>
        {metaErrors.length > 0 && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => run('fix')}
            disabled={busy !== null}
          >
            {busy === 'fix' ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Wand2 className="size-3.5" />
            )}
            {t('aiFixErrors', { count: metaErrors.length })}
          </Button>
        )}
        <span className="text-[11px] text-muted-foreground">{t('aiHint')}</span>
      </div>
    </div>
  );
}

/**
 * Live structural check of the JSON in an editor — the same linter the
 * AI builder repairs against. Meta still validates on save.
 */
export function FlowLintSummary({ json }: { json: string }) {
  const t = useTranslations('Settings.forms');
  const issues = useMemo<FlowLintIssue[] | null>(() => {
    if (!json.trim()) return null;
    try {
      return lintFlowJson(JSON.parse(json));
    } catch {
      return [{ severity: 'error', path: '$', message: t('lintNotJson') }];
    }
  }, [json, t]);

  if (!issues) return null;
  if (issues.length === 0) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-emerald-400">
        <CheckCircle2 className="size-3.5" />
        {t('lintClean')}
      </p>
    );
  }
  return (
    <div className="space-y-1 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5">
      {issues.slice(0, 12).map((i, idx) => (
        <p
          key={idx}
          className={
            i.severity === 'error'
              ? 'flex gap-1.5 text-xs text-red-400'
              : 'flex gap-1.5 text-xs text-amber-400'
          }
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>
            <span className="font-mono opacity-70">{i.path}</span> — {i.message}
          </span>
        </p>
      ))}
      {issues.length > 12 && (
        <p className="text-xs text-muted-foreground">
          {t('lintMore', { count: issues.length - 12 })}
        </p>
      )}
    </div>
  );
}
