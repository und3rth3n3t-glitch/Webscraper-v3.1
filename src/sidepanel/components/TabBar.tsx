type Tab = 'config' | 'saved' | 'queue' | 'settings';

interface Props {
  activeTab: Tab;
  onTabClick: (tab: Tab) => void;
}

const TABS: { id: Tab; label: string }[] = [
  { id: 'config', label: 'Config' },
  { id: 'saved', label: 'Saved' },
  { id: 'queue', label: 'Queue' },
  { id: 'settings', label: 'Settings' },
];

export default function TabBar({ activeTab, onTabClick }: Props) {
  return (
    <nav className="tab-bar">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          className={`tab-btn ${activeTab === tab.id ? 'active' : ''}`}
          onClick={() => onTabClick(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}
