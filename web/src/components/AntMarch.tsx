// Signature element: a line of tiny ants marching along a panel edge.
const TRAIL = "🐜 ".repeat(24);

export function AntMarch({ className = "" }: { className?: string }) {
  return (
    <div aria-hidden className={`ant-march ${className}`}>
      <span>
        {TRAIL}
        {TRAIL}
      </span>
    </div>
  );
}
