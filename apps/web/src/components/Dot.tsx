/**
 * Pulsing dot used in streaming placeholders. The `dot-pulse` keyframes
 * are defined globally in `styles.css` so this works regardless of
 * mount order.
 */
export function Dot({ delay }: { delay: number }) {
  return (
    <span
      className="h-1.5 w-1.5 rounded-full bg-subtle"
      style={{
        animation: `dot-pulse 1.4s ${delay}ms ease-in-out infinite`,
      }}
    />
  );
}