import { useState } from 'react';
import ConfirmDialog from './ConfirmDialog';
import { useConfigStore } from '../stores/configStore';

export default function ConfigToolbar() {
  const { view, isDirty, newConfig } = useConfigStore();
  const [confirming, setConfirming] = useState<'home' | 'new' | null>(null);

  if (view === 'NO_CONFIG' || view === 'CREATE_CONFIG') return null;

  const handleHome = () => {
    if (isDirty) { setConfirming('home'); } else { newConfig(); }
  };

  const handleNew = () => {
    if (isDirty) {
      setConfirming('new');
    } else {
      newConfig();
      setTimeout(() => useConfigStore.getState().pushView('CREATE_CONFIG'), 0);
    }
  };

  const handleConfirm = () => {
    const action = confirming;
    setConfirming(null);
    newConfig();
    if (action === 'new') {
      setTimeout(() => useConfigStore.getState().pushView('CREATE_CONFIG'), 0);
    }
  };

  return (
    <>
      <div className="config-toolbar">
        <button className="btn btn-ghost btn-sm" onClick={handleHome}>Home</button>
        <button className="btn btn-ghost btn-sm" onClick={handleNew}>+ New</button>
      </div>
      {confirming && (
        <ConfirmDialog
          title="Discard unsaved changes?"
          message="You have unsaved changes to this config. Discard them?"
          confirmLabel="Discard"
          confirmVariant="danger"
          onConfirm={handleConfirm}
          onCancel={() => setConfirming(null)}
        />
      )}
    </>
  );
}
