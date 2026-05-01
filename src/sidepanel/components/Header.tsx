import brand from '@/themes';

export default function Header() {
  return (
    <header className="header">
      <img src="/assets/download.svg" alt={brand.appName} className="header-logo" />
      <span className="header-version">v{__APP_VERSION__}</span>
    </header>
  );
}
