'use client';

import { AlertCircle } from 'lucide-react';

/** A Meta Flow JSON validation error, as Meta reports it. */
export interface FlowValidationError {
  error?: string;
  error_type?: string;
  message: string;
  line_start?: number;
  column_start?: number;
}

/** Meta's validation errors for a form definition, with line numbers. */
export function ValidationErrorList({ errors }: { errors: FlowValidationError[] }) {
  if (errors.length === 0) return null;
  return (
    <div className="space-y-1.5 rounded-lg border border-red-500/30 bg-red-500/5 p-3">
      {errors.map((e, i) => (
        <div key={i} className="flex gap-2 text-xs text-red-400">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {e.line_start !== undefined && (
              <span className="mr-1 font-mono">
                L{e.line_start}
                {e.column_start !== undefined ? `:${e.column_start}` : ''}
              </span>
            )}
            {e.message}
            {e.error ? <span className="ml-1 opacity-70">({e.error})</span> : null}
          </span>
        </div>
      ))}
    </div>
  );
}
