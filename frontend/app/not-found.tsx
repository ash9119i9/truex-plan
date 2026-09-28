export default function NotFound() {
  return (
    <main className="app-error">
      <div className="app-error-card">
        <h1>Page not found</h1>
        <p>This page doesn’t exist or has moved.</p>
        <a className="button button-primary" href="/">
          Go to the workspace
        </a>
      </div>
    </main>
  );
}
