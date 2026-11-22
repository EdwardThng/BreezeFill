import Logo from "./Logo";

export default function Nav() {
  return (
    <nav className="nav" aria-label="Main">
      <a className="brand" href="#/">
        <Logo />
        <span>BreezeFill</span>
      </a>
      <div className="nav-links">
        <a href="#how">How it works</a>
        <a href="#privacy">Privacy</a>
        <a href="#pricing">Pricing</a>
        <a href="#faq">FAQ</a>
      </div>
      <a className="btn btn-small" href="#/demo">
        See the demo
      </a>
    </nav>
  );
}
