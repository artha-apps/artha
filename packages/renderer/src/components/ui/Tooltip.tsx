/**
 * Tooltip — brand-styled wrapper around @radix-ui/react-tooltip.
 *
 * Usage:
 *   <Tooltip content="Reload this page">
 *     <button onClick={reload}><RotateCw /></button>
 *   </Tooltip>
 *
 * Children must be a single focusable element (Radix uses `asChild` internally
 * to attach refs/handlers). The TooltipProvider is mounted once at app root in
 * App.tsx so we don't need to wrap individual usages.
 *
 * Style: cream surface, hairline border, deep navy text, light shadow. Opens on
 * hover after 400ms (sane default — fast enough to feel responsive, slow enough
 * not to interrupt scanning).
 */
import * as RadixTooltip from '@radix-ui/react-tooltip';
import { ReactNode } from 'react';

interface TooltipProps {
  /** Tooltip body — usually a short verb phrase. Keep under ~60 chars. */
  content: ReactNode;
  /** The trigger element (button, link, icon). Must accept a forwarded ref. */
  children: ReactNode;
  /** Which side of the trigger to render on. Radix falls back automatically
   *  when the preferred side would overflow the viewport. */
  side?: 'top' | 'right' | 'bottom' | 'left';
  /** Pixel offset from the trigger. Default 6 — tight but breathing room. */
  sideOffset?: number;
  /** Disable rendering entirely (without removing the wrapper). Useful when
   *  the same component renders in both tooltip-friendly and inline contexts. */
  disabled?: boolean;
}

export function Tooltip({
  content,
  children,
  side = 'top',
  sideOffset = 6,
  disabled = false,
}: TooltipProps) {
  if (disabled) return <>{children}</>;

  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          sideOffset={sideOffset}
          className="
            z-[100]
            max-w-xs
            rounded-md
            border border-artha-border
            bg-artha-surface
            px-2.5 py-1.5
            text-[12px] font-medium
            text-artha-text
            shadow-lifted
            animate-in fade-in-0 zoom-in-95
            data-[state=closed]:animate-out
            data-[state=closed]:fade-out-0
            data-[state=closed]:zoom-out-95
          "
        >
          {content}
          <RadixTooltip.Arrow className="fill-artha-surface stroke-artha-border" strokeWidth={1} />
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}

/** Re-export the Provider — App.tsx mounts one at the root. */
export const TooltipProvider = RadixTooltip.Provider;
