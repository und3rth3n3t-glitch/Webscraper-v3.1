type Props = {
  fieldName: string | null;
  value: unknown;
};

export default function RawJsonCard({ fieldName, value }: Props) {
  return (
    <section className="card">
      <div className="run-log-title">{fieldName ? `Raw — ${fieldName}` : 'Raw'}</div>
      <pre className="json-preview" style={{ maxHeight: 400 }}>
        {JSON.stringify(value, null, 2)}
      </pre>
    </section>
  );
}
