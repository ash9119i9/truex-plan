export default function NotFound() {
  return (
    <main className="app-error">
      <div className="tx-card tx-state app-error-card">
        <h1 className="t-h3">Page not found</h1>
        <p>This page doesn’t exist or has moved.</p>
        <a className="tx-btn tx-primary" href="/">
          Go to the workspace
        </a>
      </div>
    </main>
  );
}
