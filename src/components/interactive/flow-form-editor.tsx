"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";

import { Input } from "@/components/ui/input";
import { INTERACTIVE_LIMITS } from "@/lib/whatsapp/meta-api";
import { listScreenIds } from "@/lib/whatsapp/wa-flows/definition";
import type { InteractiveFlowPayload } from "@/lib/whatsapp/interactive";
import type { WhatsAppFlow } from "@/types";

/** The catalog fields the picker needs (`GET /api/whatsapp/flows`). */
export type FormOption = Pick<
  WhatsAppFlow,
  "id" | "meta_flow_id" | "name" | "status" | "first_screen" | "flow_json"
>;

let cache: Promise<FormOption[]> | null = null;

/**
 * The account's WhatsApp Forms, fetched once per page load and shared
 * by every builder on the page (an automation can hold several form
 * steps). `refresh` drops the cache — the settings panel calls it
 * after a sync.
 */
export function loadForms(refresh = false): Promise<FormOption[]> {
  if (!cache || refresh) {
    cache = fetch("/api/whatsapp/flows")
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { flows?: FormOption[] };
        return body.flows ?? [];
      })
      .catch((err) => {
        cache = null;
        throw err;
      });
  }
  return cache;
}

export function useWhatsAppForms(): {
  forms: FormOption[];
  loading: boolean;
  error: string | null;
} {
  const [forms, setForms] = useState<FormOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    loadForms()
      .then((list) => live && setForms(list))
      .catch((err) => live && setError(err instanceof Error ? err.message : String(err)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, []);
  return { forms, loading, error };
}

/**
 * The form-specific half of the interactive builder: which form, the
 * button that opens it, and (advanced) the opening screen + action.
 * Body / header / footer are edited by the shared builder above.
 */
export function FlowFormEditor({
  value,
  onChange,
  advanced,
}: {
  value: InteractiveFlowPayload;
  onChange: (p: InteractiveFlowPayload) => void;
  advanced: boolean;
}) {
  const { forms, loading, error } = useWhatsAppForms();
  const selected = forms.find((f) => f.meta_flow_id === value.flow_id) ?? null;
  // Published forms are sendable; drafts only in test mode.
  const options = useMemo(
    () =>
      forms.filter(
        (f) =>
          f.status === "PUBLISHED" ||
          (value.mode === "draft" && f.status === "DRAFT") ||
          f.meta_flow_id === value.flow_id,
      ),
    [forms, value.mode, value.flow_id],
  );
  const screens = listScreenIds(selected?.flow_json);

  return (
    <div className="flex flex-col gap-3">
      <div>
        <label className="mb-1 block text-xs text-muted-foreground">Form</label>
        {loading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading forms…
          </div>
        ) : error ? (
          <p className="text-xs text-red-400">Couldn&apos;t load forms ({error}).</p>
        ) : options.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No published forms yet.{" "}
            <Link href="/settings?tab=forms" className="text-primary underline">
              Sync or create one in Settings → WhatsApp Forms
            </Link>
            .
          </p>
        ) : (
          <select
            value={value.flow_id}
            onChange={(e) => {
              const form = forms.find((f) => f.meta_flow_id === e.target.value);
              onChange({
                ...value,
                flow_id: e.target.value,
                flow_name: form?.name,
                // A screen picked for the previous form won't exist on this one.
                screen: undefined,
              });
            }}
            className="h-9 w-full rounded-md border border-border bg-muted px-2 text-sm text-foreground"
          >
            <option value="">Choose a form…</option>
            {options.map((f) => (
              <option key={f.id} value={f.meta_flow_id}>
                {f.name}
                {f.status !== "PUBLISHED" ? ` (${f.status.toLowerCase()})` : ""}
              </option>
            ))}
          </select>
        )}
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between">
          <label className="text-xs text-muted-foreground">Button label</label>
          <span className="text-[10px] text-muted-foreground">
            {value.cta.length}/{INTERACTIVE_LIMITS.flowCtaMaxLength}
          </span>
        </div>
        <Input
          value={value.cta}
          maxLength={INTERACTIVE_LIMITS.flowCtaMaxLength}
          onChange={(e) => onChange({ ...value, cta: e.target.value })}
          placeholder="e.g. Fill in form"
          className="bg-muted text-foreground"
        />
      </div>

      {advanced && (
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Action</label>
            <select
              value={value.flow_action ?? "navigate"}
              onChange={(e) =>
                onChange({
                  ...value,
                  flow_action: e.target.value as InteractiveFlowPayload["flow_action"],
                })
              }
              className="h-9 w-full rounded-md border border-border bg-muted px-2 text-sm text-foreground"
            >
              <option value="navigate">Open a screen</option>
              <option value="data_exchange">Ask the data endpoint</option>
            </select>
          </div>
          {(value.flow_action ?? "navigate") === "navigate" && (
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">
                Opening screen
              </label>
              <select
                value={value.screen ?? ""}
                onChange={(e) =>
                  onChange({ ...value, screen: e.target.value || undefined })
                }
                className="h-9 w-full rounded-md border border-border bg-muted px-2 text-sm text-foreground"
              >
                <option value="">
                  Default{selected?.first_screen ? ` (${selected.first_screen})` : ""}
                </option>
                {screens.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </div>
          )}
          <label className="col-span-2 flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={value.mode === "draft"}
              onChange={(e) =>
                onChange({ ...value, mode: e.target.checked ? "draft" : undefined })
              }
              className="h-3.5 w-3.5 accent-primary"
            />
            Test mode — allow sending draft forms
          </label>
        </div>
      )}
    </div>
  );
}
