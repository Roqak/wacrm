'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { WHATSAPP_FLOW_CATEGORIES, type WhatsAppFlow } from '@/types';
import { apiJson } from './api';
import { STARTER_FLOW_JSON } from './starter-flow';
import type { FlowValidationError } from './validation-errors';

export function CreateFormDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (flow: WhatsAppFlow) => void;
}) {
  const t = useTranslations('Settings.forms');
  const [name, setName] = useState('');
  const [categories, setCategories] = useState<string[]>(['LEAD_GENERATION']);
  const [json, setJson] = useState(JSON.stringify(STARTER_FLOW_JSON, null, 2));
  const [publish, setPublish] = useState(false);
  const [saving, setSaving] = useState(false);

  const toggleCategory = (c: string) =>
    setCategories((prev) =>
      prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c],
    );

  const submit = async () => {
    let flowJson: unknown;
    if (json.trim()) {
      try {
        flowJson = JSON.parse(json);
      } catch (e) {
        toast.error(t('jsonInvalid', { message: e instanceof Error ? e.message : '' }));
        return;
      }
    }
    setSaving(true);
    try {
      const result = await apiJson<{
        flow: WhatsAppFlow;
        validation_errors: FlowValidationError[];
      }>('/api/whatsapp/flows', {
        method: 'POST',
        body: JSON.stringify({ name, categories, flow_json: flowJson, publish }),
      });
      // Meta can accept a definition and still report errors; the
      // detail view that opens next lists them.
      if (result.validation_errors.length > 0) {
        toast.warning(t('createdWithErrors'));
      } else {
        toast.success(publish ? t('createdPublished') : t('createdDraft'));
      }
      onCreated(result.flow);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('createFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('createTitle')}</DialogTitle>
          <DialogDescription>{t('createDesc')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>{t('name')}</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('namePlaceholder')}
              maxLength={200}
            />
          </div>

          <div className="space-y-1.5">
            <Label>{t('categoriesLabel')}</Label>
            <div className="flex flex-wrap gap-1.5">
              {WHATSAPP_FLOW_CATEGORIES.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => toggleCategory(c)}
                  className={cn(
                    'rounded-full border px-2.5 py-1 text-xs transition-colors',
                    categories.includes(c)
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border text-muted-foreground hover:text-foreground',
                  )}
                >
                  {t(`categories.${c}`)}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>{t('definition')}</Label>
            <p className="text-xs text-muted-foreground">{t('definitionHelp')}</p>
            <Textarea
              value={json}
              onChange={(e) => setJson(e.target.value)}
              spellCheck={false}
              className="min-h-72 font-mono text-xs"
            />
          </div>

          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={publish}
              onChange={(e) => setPublish(e.target.checked)}
              className="size-4 accent-primary"
            />
            {t('publishNow')}
          </label>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            onClick={submit}
            disabled={saving || !name.trim() || categories.length === 0}
          >
            {saving && <Loader2 className="size-3.5 animate-spin" />}
            {t('create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
