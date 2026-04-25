export default function Header() {
  return (
    <header className="header">
      <img src="/assets/download.svg" alt="Blueberry" className="header-logo" />
      <span className="header-version">v{__APP_VERSION__}</span>
    </header>
  );
}
