// The outline draws in and erases again, and the dots pulse in turn.
const TRIANGLE = [[16, 6], [24.66, 21], [7.34, 21]] as const;

export function LogoLoader({ className, label = "Running" }: { className?: string; label?: string }) {
  return (
    <svg role="img" aria-label={label} viewBox="0 0 32 32" fill="currentColor" className={className}>
      <path className="logo-outline" pathLength={1} d={`M${TRIANGLE.map(([x, y]) => `${x} ${y}`).join("L")}Z`} fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinejoin="round" />
      {TRIANGLE.map(([cx, cy], i) => (
        <circle key={i} className={i ? `logo-dot logo-dot-${i + 1}` : "logo-dot"} cx={cx} cy={cy} r={4.5} />
      ))}
    </svg>
  );
}
