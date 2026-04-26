import type { CardKind, FieldCard } from '../../utils/cardDiscrimination';
import TableCard from './TableCard';
import ChartCard from './ChartCard';
import PageBlocksCard from './PageBlocksCard';
import TextCard from './TextCard';
import RawJsonCard from './RawJsonCard';

export default function IterationCards({ card }: { card: CardKind }) {
  if (card.kind === 'empty') {
    return (
      <div className="empty-state" style={{ minHeight: 80 }}>
        <div className="empty-state-desc">No data extracted.</div>
      </div>
    );
  }
  if (card.kind === 'table-iteration') {
    return <TableCard rows={card.rows} mapping={card.mapping} />;
  }
  return (
    <div className="flex flex-col gap-sm">
      {card.perRow.map((cards, rowIdx) => (
        <div key={rowIdx} className="flex flex-col gap-sm">
          {cards.map((c, i) => <FieldCardRender key={i} card={c} />)}
        </div>
      ))}
    </div>
  );
}

function FieldCardRender({ card }: { card: FieldCard }) {
  switch (card.kind) {
    case 'chart':       return <ChartCard fieldName={card.fieldName} value={card.value} />;
    case 'table-field': return <TableCard rows={card.rows} fieldName={card.fieldName} />;
    case 'pageblocks':  return <PageBlocksCard fieldName={card.fieldName} value={card.value} />;
    case 'text':        return <TextCard fields={card.fields} />;
    case 'raw':         return <RawJsonCard fieldName={card.fieldName} value={card.value} />;
  }
}
