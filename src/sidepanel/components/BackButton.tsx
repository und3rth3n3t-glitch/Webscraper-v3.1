import { ChevronLeft } from 'lucide-react';
import { useConfigStore } from '../stores/configStore';

interface Props {
  onClick?: () => void;
  label?: string;
}

export default function BackButton({ onClick, label = '' }: Props) {
  const goBack = useConfigStore((s) => s.goBack);
  const handleClick = onClick || goBack;

  return (
    <button className="back-btn" onClick={handleClick} title="Go back" aria-label="Go back">
      <ChevronLeft size={18} />
      {label && <span className="back-btn-label">{label}</span>}
    </button>
  );
}
