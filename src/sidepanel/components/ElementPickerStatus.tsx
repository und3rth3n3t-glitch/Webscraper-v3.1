import { useState } from 'react';
import { useUiStore } from '../stores/uiStore';
import { sendToContent } from '../utils/messaging';
import { useContentMessage } from '../utils/messageDispatcher';

interface HoverInfo {
  tagName: string;
  className: string;
  textSnippet: string;
}

export default function ElementPickerStatus() {
  const { isPickerActive, setPickerActive } = useUiStore();
  const [hoverInfo, setHoverInfo] = useState<HoverInfo | null>(null);

  useContentMessage('ELEMENT_HOVER', (payload) => {
    setHoverInfo(payload as HoverInfo);
  });

  useContentMessage('PICKER_CANCELLED', () => {
    setPickerActive(false);
    setHoverInfo(null);
  });

  useContentMessage('ELEMENT_PICKED', () => {
    setPickerActive(false);
    setHoverInfo(null);
  });

  if (!isPickerActive) return null;

  const handleCancel = async () => {
    await sendToContent('CANCEL_PICKER');
    setPickerActive(false);
  };

  return (
    <div className="picker-status">
      <div className="picker-pulse" />
      <h3 className="picker-title">Pick an Element</h3>
      <p className="picker-hint">Click any element on the page to select it. Press Escape to cancel.</p>

      {hoverInfo && (
        <div className="picker-hover-preview">
          <span className="picker-hover-tag">
            &lt;{hoverInfo.tagName}{hoverInfo.className ? `.${hoverInfo.className}` : ''}&gt;
          </span>
          {hoverInfo.textSnippet && (
            <span className="picker-hover-text">"{hoverInfo.textSnippet}"</span>
          )}
        </div>
      )}

      <button className="btn btn-ghost btn-sm" onClick={handleCancel}>Cancel</button>
    </div>
  );
}
