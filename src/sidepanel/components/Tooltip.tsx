import { useState, type ReactNode } from 'react';

interface Props {
  text: string;
  children?: ReactNode;
}

export default function Tooltip({ text, children }: Props) {
  const [visible, setVisible] = useState(false);

  return (
    <span
      className="tooltip-wrapper"
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      onFocus={() => setVisible(true)}
      onBlur={() => setVisible(false)}
    >
      {children || (
        <span className="tooltip-icon" tabIndex={0} role="img" aria-label="Help">?</span>
      )}
      {visible && text && (
        <span className="tooltip-popup" role="tooltip">{text}</span>
      )}
    </span>
  );
}
