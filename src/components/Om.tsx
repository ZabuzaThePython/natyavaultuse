import { cn } from "@/lib/utils";

/**
 * The NatyaVault mark: the Devanagari "Om" (ॐ).
 *
 * Rendered as text so it inherits the brand gold through `currentColor`. Size
 * it with a Tailwind text utility — the brand tiles that hold it are flex
 * containers, so the glyph centres itself inside the box.
 */
export function Om({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block leading-none select-none", className)}
    >
      ॐ
    </span>
  );
}
