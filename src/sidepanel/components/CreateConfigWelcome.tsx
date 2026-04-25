import EmptyState from './EmptyState';
import { useConfigStore } from '../stores/configStore';

export default function CreateConfigWelcome() {
  const pushView = useConfigStore(s => s.pushView);

  return (
    <EmptyState
      title="Create a Scraping Flow"
      description="Add steps to build an automated scraper for this website."
      action={
        <button className="btn btn-primary" onClick={() => pushView('CREATE_CONFIG')}>
          + Add Config
        </button>
      }
    />
  );
}
