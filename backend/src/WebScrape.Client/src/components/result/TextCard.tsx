type Props = {
  fields: Record<string, string | number | boolean | null>;
};

export default function TextCard({ fields }: Props) {
  const entries = Object.entries(fields);
  if (entries.length === 0) return null;
  return (
    <section className="card">
      <div className="run-log-title">Fields</div>
      <dl className="flex flex-col gap-xs" style={{ margin: 0 }}>
        {entries.map(([k, v]) => (
          <div key={k} className="flex gap-sm" style={{ alignItems: 'baseline' }}>
            <dt className="text-xs text-light" style={{ minWidth: 120 }}>{k}</dt>
            <dd className="text-sm" style={{ margin: 0 }}>{v === null ? '—' : String(v)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
